#!/bin/bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: node-guard.sh apply --pod-cidr CIDR[,CIDR...] --tunnel-interface NAME --node-ips IP[,IP...] [--dry-run]
       node-guard.sh status
       node-guard.sh remove

Run on each node with nft privileges; rendering requires python3 (standard library).
--dry-run prints the nft transaction without loading it. --pod-cidr is recorded
only, not matched; interface matches protect against all sources, including spoofing.
Pass every node address, including public addresses. Both IP families are supported.
Keep this script and deploy/k8s/node-guard.nft.tmpl in their repository layout.
Use systemctl reload node-guard: restart briefly removes the rules via ExecStop.
nftables.service reload propagates apply to the active guard service.
Ordering is fail-open: k3s still starts if apply fails. Operators decide whether
to add RequiredBy=k3s.service k3s-agent.service and enable that dependency.
USAGE
}
fail() { printf '%s\n' "$*" >&2; exit 1; }
action=${1:---help}
if [[ $action == --help ]]; then usage; exit 0; fi
shift
case "$action" in
  status) [[ $# == 0 ]] || fail 'status takes no arguments'; nft list table inet workpartner_guard; exit 0 ;;
  remove)
    [[ $# == 0 ]] || fail 'remove takes no arguments'
    tables=$(nft list tables)
    if [[ $'\n'"$tables"$'\n' == *$'\ntable inet workpartner_guard\n'* ]]; then
      nft delete table inet workpartner_guard
    fi
    exit 0 ;;
  apply)
    command -v python3 >/dev/null 2>&1 || fail 'node-guard apply requires python3 (standard library) for strict IP/CIDR validation and rendering'
    ;;
  *) usage >&2; exit 1 ;;
esac
pod_cidrs= tunnel_interface= node_ips= dry_run=false
while (( $# )); do
  case "$1" in
    --pod-cidr|--tunnel-interface|--node-ips)
      [[ $# -ge 2 && -n $2 ]] || fail "Missing value for $1"
      case "$1" in
        --pod-cidr) pod_cidrs=$2 ;;
        --tunnel-interface) tunnel_interface=$2 ;;
        --node-ips) node_ips=$2 ;;
      esac
      shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
[[ -n $pod_cidrs && -n $tunnel_interface && -n $node_ips ]] || fail 'Pod CIDRs, tunnel interface and node IPs are required'
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
rules=$(mktemp)
trap 'rm -f -- "$rules"' EXIT
python3 - "$root/deploy/k8s/node-guard.nft.tmpl" "$pod_cidrs" "$tunnel_interface" "$node_ips" >"$rules" <<'PY'
import ipaddress
import pathlib
import re
import sys

template, cidrs, interface, addresses = sys.argv[1:]
try:
    if '%' in cidrs:
        raise ValueError('Scoped Pod networks are not supported')
    networks = [str(ipaddress.ip_network(value, strict=True)) for value in cidrs.split(',')]
    nodes = list(dict.fromkeys(ipaddress.ip_address(value) for value in addresses.split(',')))
    if not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,15}', interface) or interface == 'cni0':
        raise ValueError('Invalid tunnel interface')
    if any('%' in str(node) for node in nodes):
        raise ValueError('Scoped node addresses are not supported')
except ValueError as error:
    sys.exit(str(error))
def elements(version):
    values = ', '.join(str(node) for node in nodes if node.version == version)
    return 'elements = { ' + values + ' }' if values else ''
text = pathlib.Path(template).read_text()
for key, value in {
    'POD_CIDRS': ', '.join(networks),
    'TUNNEL_INTERFACE': interface,
    'NODE_IPV4_ELEMENTS': elements(4),
    'NODE_IPV6_ELEMENTS': elements(6),
}.items():
    text = text.replace('@' + key + '@', value)
print(text, end='')
PY
if $dry_run; then
  cat "$rules"
else
  nft -c -f "$rules"
  nft -f "$rules"
fi
