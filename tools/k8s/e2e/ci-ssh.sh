#!/usr/bin/env bash
# Private PATH shim for K6's remote() protocol. Never falls back to real SSH.
set -euo pipefail
[[ $# == 5 && $1 == -o && $2 == BatchMode=yes && $3 == -- ]] || { echo 'Unsupported K6 SSH invocation' >&2; exit 2; }
[[ $4 == "${CI_E2E_SERVER:?}" || $4 == "${CI_E2E_AGENT:?}" ]] || { echo 'Unexpected k3d node' >&2; exit 2; }
# K6 shell-quotes every word. k3d exposes crictl/ctr as standalone binaries;
# rewrite only these exact prefixes, leaving every following byte intact.
command=$5
case "$command" in
  "'k3s' 'crictl' "*|"'k3s' 'ctr' "*) command=${command#"'k3s' "} ;;
  "'df' "*) ;;
  *) echo 'Unsupported K6 command prefix' >&2; exit 2 ;;
esac
# docker exec -i preserves the binary docker-save stream during import.
exec docker exec -i "$4" sh -c "$command"
