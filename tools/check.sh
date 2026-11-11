#!/bin/bash
# Linux checks for the exported source tree; no images are built by this command.
set -euo pipefail
cd "$(dirname "$0")/.."
mapfile -d '' modules < <(find gateway feishu preview image -type f \( -name '*.mjs' -o -name '*.js' \) -print0)
for module in "${modules[@]}"; do node --check "$module"; done
python3 -I -B - <<'PY'
import ast
from pathlib import Path
for root in ('image', 'tools'):
    for path in Path(root).rglob('*.py'):
        ast.parse(path.read_bytes(), filename=str(path))
PY
shopt -s nullglob
bash -n image/bin/*.sh image/build.sh image/agent-baseline/install.sh
for script in tools/k8s/*.sh; do bash -n "$script"; done
python3 -I -B tools/wp-seed.test.py image/bin/wp-seed.py
for test in image/tests/*.test.py; do python3 -I -B "$test"; done
python3 -I -B image/agent-baseline/hooks/test_no_blocking_foreground.py
python3 -I -B image/agent-baseline/hooks/test_no_repeat_poll.py
node --test tools/*.test.mjs gateway/tests/*.test.mjs
if [ -n "${WORKPARTNER_TEST_IMAGE:-}" ]; then
  # Use the image's configured runtime user and system trust store, without networking.
  docker run --rm -i --network none --entrypoint python3 "$WORKPARTNER_TEST_IMAGE" -I - <<'PY'
import ssl
from pathlib import Path
assert Path('/etc/ssl/certs/ca-certificates.crt').stat().st_size > 0
assert ssl.create_default_context().cert_store_stats()['x509_ca'] > 0
PY
fi
