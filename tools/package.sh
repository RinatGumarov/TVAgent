#!/usr/bin/env bash
# Builds the Chrome Web Store upload: dist/tvagent-<version>.zip
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$root/extension/manifest.json")"
out="$root/dist/tvagent-$version.zip"

# Refresh the page world's copies of the shared modules before zipping.
"$root/tools/sync-worlds.sh" >/dev/null

mkdir -p "$root/dist"
rm -f "$out"
cd "$root/extension"
zip -r -q -X "$out" . -x '.*' -x '*/.*' -x '*.DS_Store'

cd "$root"
echo "$out"
unzip -l "$out"
