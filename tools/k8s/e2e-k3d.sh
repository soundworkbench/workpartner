#!/usr/bin/env bash
set -euo pipefail
usage() {
  cat <<'HELP'
Usage: K3S_IMAGE=REF tools/k8s/e2e-k3d.sh up --prefix wp-e2e-SUFFIX --image REF --gateway-image REF --kubeconfig JSON
       tools/k8s/e2e-k3d.sh down --prefix wp-e2e-SUFFIX
The two images must already be built. The kubeconfig destination must not exist.
Uses one server and one agent, with traefik disabled. K3S_IMAGE is mandatory for up.
HELP
}
action=${1:---help}
[[ $action != --help ]] || { usage; exit 0; }
shift
prefix= image= gateway_image= kubeconfig=
while (( $# )); do
  [[ $# -ge 2 && -n $2 && $2 != --* ]] || { usage >&2; exit 2; }
  case "$1" in
    --prefix) prefix=$2 ;; --image) image=$2 ;; --gateway-image) gateway_image=$2 ;; --kubeconfig) kubeconfig=$2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift 2
done
[[ $prefix =~ ^wp-e2e-[a-z0-9]([a-z0-9-]*[a-z0-9])?$ && ${#prefix} -le 30 ]] || { echo 'Invalid test prefix' >&2; exit 2; }
case "$action" in
  down) k3d cluster delete "$prefix" ;;
  up)
    [[ -n ${K3S_IMAGE:-} && -n $image && -n $gateway_image && -n $kubeconfig ]] || { usage >&2; exit 2; }
    [[ ! -e $kubeconfig ]] || { echo 'Kubeconfig destination already exists' >&2; exit 2; }
    temporary=$(mktemp)
    created=false
    finish() {
      local status=$?
      rm -f -- "$temporary"
      if (( status != 0 )) && $created; then k3d cluster delete "$prefix"; fi
      return "$status"
    }
    trap finish EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    # Refuse to adopt an existing cluster; only successful creation grants deletion ownership.
    k3d cluster create "$prefix" --servers 1 --agents 1 --image "$K3S_IMAGE" \
      --k3s-arg '--disable=traefik@server:*' --kubeconfig-update-default=false --kubeconfig-switch-context=false
    created=true
    k3d image import --cluster "$prefix" "$image" "$gateway_image"
    k3d kubeconfig get "$prefix" >"$temporary"
    (umask 077; set -o noclobber; kubectl --kubeconfig "$temporary" config view --raw --minify --flatten -o json >"$kubeconfig")
    printf 'JSON kubeconfig: %s\n' "$kubeconfig"
    ;;
  *) usage >&2; exit 2 ;;
esac
