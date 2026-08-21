#!/usr/bin/env bash
# Builds the Chrome Web Store upload: dist/tvagent-<version>.zip
#
# The store wants a zip whose ROOT is the manifest, not a folder containing it,
# so this zips from inside extension/.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The path is passed as an argument rather than interpolated into the Python
# source: a directory with an apostrophe in it used to close the string literal
# and take the script with it.
version="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$root/extension/manifest.json")"
out="$root/dist/tvagent-$version.zip"

# The page world's copies of the shared modules are part of the tree, not of
# the zip step — but a stale copy ships silently, so refresh them here too.
"$root/tools/sync-worlds.sh" >/dev/null

mkdir -p "$root/dist"
rm -f "$out"
cd "$root/extension"
zip -r -q -X "$out" . -x '.*' -x '*/.*' -x '*.DS_Store'

cd "$root"
echo "$out"
unzip -l "$out"
