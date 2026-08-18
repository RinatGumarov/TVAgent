#!/usr/bin/env bash
# Builds the Chrome Web Store upload: dist/tvagent-<version>.zip
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(python3 -c "import json;print(json.load(open('$root/extension/manifest.json'))['version'])")"
out="$root/dist/tvagent-$version.zip"

mkdir -p "$root/dist"
rm -f "$out"
cd "$root/extension"
zip -r -q -X "$out" . -x '.*' -x '*/.*' -x '*.DS_Store'

cd "$root"
echo "$out"
unzip -l "$out"
