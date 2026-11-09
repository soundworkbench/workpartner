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
