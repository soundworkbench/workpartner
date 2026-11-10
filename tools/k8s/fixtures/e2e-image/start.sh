#!/usr/bin/env bash
set -euo pipefail
source /opt/e2e/wp-init-hooks.sh
wp_init_hooks /data
node /opt/e2e/aionui.mjs &
aionui_pid=$!
node /opt/e2e/cc-connect.mjs &
connect_pid=$!
(
  until [[ -s /data/.zp-preview-relay-key ]]; do sleep 0.2; done
  gateway=$(node -e 'process.stdout.write(JSON.parse(process.env.WORKPARTNER_MODEL_CONFIG).gatewayOrigin)')
  exec node /opt/preview/workspace.mjs "$gateway"
) &
relay_pid=$!
trap 'kill "$aionui_pid" "$connect_pid" "$relay_pid" 2>/dev/null || true; wait || true' EXIT
trap 'exit 0' TERM INT
wait -n "$aionui_pid" "$connect_pid" "$relay_pid"
