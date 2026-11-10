#!/usr/bin/env bash
# E2E's NODE sh -s protocol; stdin is a script, not an interactive terminal.
set -euo pipefail
[[ $# == 3 && $2 == sh && $3 == -s ]] || { echo 'Expected NODE sh -s' >&2; exit 2; }
[[ $1 == "${CI_E2E_SERVER:?}" || $1 == "${CI_E2E_AGENT:?}" ]] || { echo 'Unexpected k3d node' >&2; exit 2; }
exec docker exec -i "$@"
