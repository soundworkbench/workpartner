#!/bin/bash
# Linux checks for the exported source tree; no images are built by this command.
set -euo pipefail
cd "$(dirname "$0")/.."
mapfile -d '' modules < <(find gateway image -type f \( -name '*.mjs' -o -name '*.js' \) -print0)
for module in "${modules[@]}"; do node --check "$module"; done
python3 -I - <<'PY'
import ast
from pathlib import Path
for root in ('image', 'tools'):
    for path in Path(root).rglob('*.py'):
        ast.parse(path.read_bytes(), filename=str(path))
PY
node --test tools/core.test.mjs
if [ -n "${WORKPARTNER_TEST_IMAGE:-}" ]; then
  # Use the image's configured runtime user and system trust store, without networking.
  docker run --rm -i --network none --entrypoint python3 "$WORKPARTNER_TEST_IMAGE" -I - <<'PY'
import ssl
from pathlib import Path
assert Path('/etc/ssl/certs/ca-certificates.crt').stat().st_size > 0
assert ssl.create_default_context().cert_store_stats()['x509_ca'] > 0
PY
fi
