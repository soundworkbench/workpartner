#!/bin/sh
# Assemble only public inputs and the explicitly selected organization.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TAG=${1:-workpartner-user:local}
: "${PKG:?Set PKG to the verified downloader output directory}"
CTX=$(mktemp -d /tmp/workpartner-build.XXXXXX)
trap 'rm -rf "$CTX"' EXIT
cp -a "$ROOT/image" "$CTX/image"
node "$ROOT/gateway/organization/materialize-next.mjs" "$CTX"
IMAGE_SKILLS=$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1])).image.skills.join(" "))' "$CTX/organization/selected/organization.json")
mkdir -p "$CTX/streaming"
cp "$ROOT/image/streaming/smooth-text.mjs" "$CTX/streaming/"
cp -a "$PKG" "$CTX/pkg"
# Cached packages may come from a private umask; the runtime user must traverse them.
chmod -R a+rX "$CTX/pkg/aionui-web"
# Native executables come from the verified archives; no private package fallback.
chmod 755 "$CTX/pkg/claude" "$CTX/pkg/cc-connect" "$CTX/pkg/officecli" "$CTX/pkg/codex" "$CTX/pkg/codex-code-mode-host"
docker build --build-arg BASE_IMAGE=node:24-bookworm-slim --build-arg "IMAGE_SKILLS=$IMAGE_SKILLS" -f "$CTX/image/Dockerfile" -t "$TAG" "$CTX"
