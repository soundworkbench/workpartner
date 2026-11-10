#!/bin/sh
# Assemble public inputs and the selected organization; --prepare-only keeps the context.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
: "${PKG:?Set PKG to the verified downloader output directory}"
python3 -I "$ROOT/tools/download-inputs.py" "$ROOT/image/third-party.lock.json" "$PKG" --verify-bridge
PREPARE_ONLY=false
if [ "${1:-}" = --prepare-only ]; then
  [ "$#" -eq 2 ] || { echo 'Usage: image/build.sh --prepare-only NEW_DIRECTORY' >&2; exit 1; }
  PREPARE_ONLY=true
  CTX=$2
  [ ! -e "$CTX" ] || { echo 'Context directory already exists' >&2; exit 1; }
  mkdir -p "$CTX"
else
  TAG=${1:-workpartner-user:local}
  CTX=$(mktemp -d /tmp/workpartner-build.XXXXXX)
  trap 'rm -rf "$CTX"' EXIT
fi
cp -a "$ROOT/image" "$CTX/image"
mkdir -p "$CTX/pkg"
cp -a "$PKG/." "$CTX/pkg/"
python3 -I "$ROOT/image/bin/wp-feishu-skills.py" --pack \
  "$PKG/lark-skills.tar.gz" "$PKG/meegle-skills.tar.gz" "$CTX/pkg/official-skills.tar.gz"
WORKPARTNER_OFFICIAL_SKILLS_ARCHIVE="$CTX/pkg/official-skills.tar.gz" \
  node "$ROOT/gateway/organization/materialize-next.mjs" "$CTX"
IMAGE_SKILLS=$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1])).image.skills.join(" "))' "$CTX/organization/selected/organization.json")
cp -a "$ROOT/preview" "$CTX/preview"
mkdir -p "$CTX/streaming"
cp "$ROOT/image/streaming/smooth-text.mjs" "$CTX/streaming/"
# Cached packages may come from a private umask; the runtime user must traverse them.
chmod -R a+rX "$CTX/pkg/aionui-web"
chmod 755 "$CTX/pkg/claude" "$CTX/pkg/cc-connect" "$CTX/pkg/officecli" "$CTX/pkg/codex" "$CTX/pkg/codex-code-mode-host"
if [ "$PREPARE_ONLY" = true ]; then
  printf 'Prepared image context: %s\n' "$CTX"
  exit 0
fi
docker build --build-arg BASE_IMAGE=node:24-bookworm-slim --build-arg "IMAGE_SKILLS=$IMAGE_SKILLS" -f "$CTX/image/Dockerfile" -t "$TAG" "$CTX"
