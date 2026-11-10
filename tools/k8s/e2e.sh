#!/usr/bin/env bash
set -euo pipefail
umask 077
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
config=$(mktemp)
trap 'rm -f -- "$config"' EXIT
node "$root/tools/k8s/e2e/options.mjs" "$@" >"$config"
for arg in "$@"; do
  case "$arg" in --help|--print-config) cat "$config"; exit 0 ;; esac
done
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if ! node "$root/tools/k8s/e2e/controller.mjs" cleanup "$config"; then if [ "$status" -eq 0 ]; then status=1; fi; fi
  rm -f -- "$config"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
node "$root/tools/k8s/e2e/controller.mjs" run "$config"
