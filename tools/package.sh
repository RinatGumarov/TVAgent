#!/usr/bin/env bash
# Zips the built extension for the Chrome Web Store: dist/tvagent-<version>.zip
# Run tools/build.mjs first, or use `npm run package`.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build="$root/build/extension"
version="$(node -p "require('$root/package.json').version")"
out="$root/dist/tvagent-$version.zip"

if [ ! -f "$build/manifest.json" ]; then
  echo "no build at build/extension — run: npm run build" >&2
  exit 1
fi

mkdir -p "$root/dist"
rm -f "$out"
cd "$build"
zip -r -q -X "$out" . -x '.*' -x '*/.*' -x '*.DS_Store'

cd "$root"
echo "$out"
unzip -l "$out"
