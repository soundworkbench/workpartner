#!/usr/bin/env bash
# GitHub-hosted disposable VM adapter. Run from the repository root.
set -euo pipefail
umask 077
: "${CI_E2E_DIR:?}"
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
cd "$root"
action=${1:?Expected init, install, build, up, run, cleanup or down}

if [[ $action == init ]]; then
  [[ ! -e $CI_E2E_DIR ]] || { echo 'Run directory already exists' >&2; exit 1; }
  node --input-type=module - "$CI_E2E_DIR" "${K3S_BASE_IMAGE:?}" "${EXTERNAL_PROBE:?}" <<'JS'
import { outsideRepository } from './tools/k8s/e2e/artifacts.mjs';
import { endpoint } from './tools/k8s/e2e/options.mjs';
import { BlockList, isIP } from 'node:net';
outsideRepository(process.argv[2]);
if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*:[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(process.argv[3])) {
  throw new Error('Supply an explicit tagged k3s image');
}
const probe = process.argv[4];
const host = /^\[([^\]]+)\]:\d+$/.exec(probe)?.[1] || probe.slice(0, probe.lastIndexOf(':'));
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['100.64.0.0', 10]]) blocked.addSubnet(address, prefix, 'ipv4');
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
const family = isIP(host);
if (family && blocked.check(host, family === 4 ? 'ipv4' : 'ipv6')) {
  throw new Error('external_probe must not be an unspecified, private, loopback, link-local or CGNAT IP');
}
// Reject ambiguous numeric/hex hostnames that resolvers may interpret as IPs.
if (!family && (/^(?:0x)?[0-9a-f]+(?:\.(?:0x)?[0-9a-f]+)*\.?$/i.test(host) || /(?:^|\.)0x/i.test(host))) {
  throw new Error('external_probe must not be a numeric or hexadecimal hostname');
}
// Keep the E2E parser's IPv4/hostname contract; IPv6 probes remain unsupported.
endpoint(probe);
JS
  mkdir -p "$CI_E2E_DIR"/{bin,logs,run-1,run-2}
  node -e 'console.log("wp-e2e-" + require("node:crypto").randomBytes(5).toString("hex"))' >"$CI_E2E_DIR/prefix"
  for iteration in 1 2; do
    printf '%s\n' '{"complete":false,"results":[]}' >"$CI_E2E_DIR/run-$iteration/results.json"
  done
  install -m 700 tools/k8s/e2e/ci-ssh.sh "$CI_E2E_DIR/bin/ssh"
  install -m 700 tools/k8s/e2e/ci-node-command.sh "$CI_E2E_DIR/bin/node-command"
  exit 0
fi

# Cleanup steps still run when setup/build failed before creating a cluster.
if [[ ! -f $CI_E2E_DIR/prefix ]]; then
  case "$action" in cleanup|down) echo 'No initialized run to clean'; exit 0 ;; esac
  echo 'Run init first' >&2; exit 1
fi
cluster=$(cat "$CI_E2E_DIR/prefix")
[[ $cluster =~ ^wp-e2e-[a-f0-9]{10}$ ]] || { echo 'Invalid saved prefix' >&2; exit 1; }
export CI_E2E_SERVER="k3d-$cluster-server-0" CI_E2E_AGENT="k3d-$cluster-agent-0"
export PATH="$CI_E2E_DIR/bin:$PATH"
export K3S_IMAGE="docker.io/library/workpartner-e2e-node:$cluster"
image="docker.io/library/workpartner-e2e:$cluster"
gateway_base="docker.io/library/workpartner-e2e-gateway-base:$cluster"
gateway_image="docker.io/library/workpartner-e2e-gateway:$cluster"
kubeconfig="$CI_E2E_DIR/kubeconfig.json"

case "$action" in
  install)
    : "${KUBECTL_VERSION:?}" "${K3D_VERSION:?}" "${KUBECTL_SHA256:?}" "${K3D_SHA256:?}"
    [[ $KUBECTL_SHA256 =~ ^[a-f0-9]{64}$ && $K3D_SHA256 =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid pinned SHA256' >&2; exit 1; }
    mkdir "$CI_E2E_DIR/downloads"
    cd "$CI_E2E_DIR/downloads"
    curl_args=(--fail --location --silent --show-error --retry 3 --connect-timeout 20 --max-time 180)
    curl "${curl_args[@]}" -o kubectl "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/amd64/kubectl"
    curl "${curl_args[@]}" -o kubectl.sha256 "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/amd64/kubectl.sha256"
    kubectl_sha=$(tr -d '\r\n' <kubectl.sha256)
    [[ $kubectl_sha =~ ^[a-fA-F0-9]{64}$ ]] || { echo 'Invalid kubectl SHA256' >&2; exit 1; }
    [[ ${kubectl_sha,,} == "$KUBECTL_SHA256" ]] || { echo 'Published kubectl SHA256 differs from pin' >&2; exit 1; }
    printf '%s  kubectl\n' "$KUBECTL_SHA256" | sha256sum --check --strict -
    curl "${curl_args[@]}" -o k3d-linux-amd64 "https://github.com/k3d-io/k3d/releases/download/$K3D_VERSION/k3d-linux-amd64"
    curl "${curl_args[@]}" -o checksums.txt "https://github.com/k3d-io/k3d/releases/download/$K3D_VERSION/checksums.txt"
    awk '$2 == "k3d-linux-amd64" || $2 == "*k3d-linux-amd64" { print }' checksums.txt >k3d.sha256
    [[ $(wc -l <k3d.sha256) == 1 ]] || { echo 'Missing or ambiguous k3d SHA256' >&2; exit 1; }
    k3d_sha=$(awk '{ print $1 }' k3d.sha256)
    [[ ${k3d_sha,,} == "$K3D_SHA256" ]] || { echo 'Published k3d SHA256 differs from pin' >&2; exit 1; }
    printf '%s  k3d-linux-amd64\n' "$K3D_SHA256" | sha256sum --check --strict -
    install -m 700 kubectl "$CI_E2E_DIR/bin/kubectl"
    install -m 700 k3d-linux-amd64 "$CI_E2E_DIR/bin/k3d"
    node --version
    kubectl version --client
    k3d version
    ;;
  build)
    docker build --platform linux/amd64 -f gateway/Dockerfile -t "$gateway_base" .
    docker build --platform linux/amd64 -f tools/k8s/fixtures/e2e-image/Dockerfile -t "$image" .
    docker build --platform linux/amd64 -f tools/k8s/fixtures/e2e-image/gateway.Dockerfile \
      --build-arg "GATEWAY_BASE=$gateway_base" -t "$gateway_image" .
    # k3s images need not contain apk. Keep Alpine's nft and loader/libraries
    # isolated, preserving the requested base's k3s binary, entrypoint and libs.
    mkdir "$CI_E2E_DIR/node-build"
    cat >"$CI_E2E_DIR/node-build/Dockerfile" <<'DOCKERFILE'
ARG K3S_BASE_IMAGE
FROM alpine:3.21.3 AS nft
RUN apk add --no-cache nftables
FROM ${K3S_BASE_IMAGE}
COPY --from=nft / /opt/e2e-nft/
COPY nft /opt/e2e-bin/nft
ENV PATH="/opt/e2e-bin:${PATH}"
DOCKERFILE
    cat >"$CI_E2E_DIR/node-build/nft" <<'SH'
#!/bin/sh
exec /opt/e2e-nft/lib/ld-musl-x86_64.so.1 --library-path /opt/e2e-nft/lib:/opt/e2e-nft/usr/lib /opt/e2e-nft/usr/sbin/nft "$@"
SH
    chmod 755 "$CI_E2E_DIR/node-build/nft"
    docker build --platform linux/amd64 --build-arg "K3S_BASE_IMAGE=${K3S_BASE_IMAGE:?}" \
      -t "$K3S_IMAGE" "$CI_E2E_DIR/node-build"
    ;;
  up)
    bash tools/k8s/e2e-k3d.sh up --prefix "$cluster" --image "$image" \
      --gateway-image "$gateway_image" --kubeconfig "$kubeconfig"
    kubectl --kubeconfig "$kubeconfig" wait --for=condition=Ready nodes --all --timeout=120s
    kubectl --kubeconfig "$kubeconfig" get nodes -o json >"$CI_E2E_DIR/nodes.json"
    node --input-type=module - "$CI_E2E_DIR/nodes.json" "$CI_E2E_DIR/pod-cidrs" <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const nodes = JSON.parse(fs.readFileSync(process.argv[2])).items;
assert.equal(nodes.length, 2);
for (const name of [process.env.CI_E2E_SERVER, process.env.CI_E2E_AGENT]) {
  const node = nodes.find(n => n.metadata.name === name);
  assert.equal(node?.metadata.labels['kubernetes.io/hostname'], name);
  assert.ok(node.spec.podCIDR);
}
fs.writeFileSync(process.argv[3], [...new Set(nodes.flatMap(n => n.spec.podCIDRs || [n.spec.podCIDR]))].join(','));
JS
    for node in "$CI_E2E_SERVER" "$CI_E2E_AGENT"; do
      docker exec "$node" nft --version
      # The helper uses k3s' default VXLAN backend; verify its actual interface.
      docker exec "$node" test -d /sys/class/net/flannel.1
      docker exec "$node" mkdir -p /var/lib/workpartner-e2e-static
      docker exec "$node" crictl images -o json
      docker exec "$node" ctr -n k8s.io images ls -q
    done
    kubectl --kubeconfig "$kubeconfig" -n kube-system wait --for=condition=Available deployment --all --timeout=180s
    kubectl --kubeconfig "$kubeconfig" wait --for=condition=Available apiservice --all --timeout=180s
    ;;
  run|cleanup)
    iteration=${2:?Expected iteration 1 or 2}
    [[ $iteration == 1 || $iteration == 2 ]] || { echo 'Invalid iteration' >&2; exit 2; }
    output="$CI_E2E_DIR/run-$iteration"
    prefix="$cluster-$iteration"
    if [[ $action == cleanup ]]; then
      if [[ ! -f $kubeconfig ]]; then echo 'No exported kubeconfig; up handles partial creation'; exit 0; fi
      bash tools/k8s/e2e.sh --cleanup --prefix "$prefix" --kubeconfig "$kubeconfig" --output "$output"
    else
      bash tools/k8s/e2e.sh --prefix "$prefix" --kubeconfig "$kubeconfig" --output "$output" \
        --image "$image" --gateway-image "$gateway_image" \
        --server-node "$CI_E2E_SERVER" --agent-node "$CI_E2E_AGENT" \
        --node-command "$CI_E2E_DIR/bin/node-command" --distribute \
        --guard --pod-cidrs "$(cat "$CI_E2E_DIR/pod-cidrs")" --tunnel-interface flannel.1 \
        --static-pv-node "$CI_E2E_SERVER" --static-pv-dir /var/lib/workpartner-e2e-static \
        --external-probe "${EXTERNAL_PROBE:?}"
      GITHUB_STEP_SUMMARY= node tools/k8s/e2e/ci-results.mjs "$output"
    fi
    ;;
  down)
    if [[ ! -x $CI_E2E_DIR/bin/k3d ]]; then echo 'k3d was not installed'; exit 0; fi
    bash tools/k8s/e2e-k3d.sh down --prefix "$cluster"
    ;;
  *) echo 'Unknown action' >&2; exit 2 ;;
esac
