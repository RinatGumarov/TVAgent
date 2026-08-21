#!/usr/bin/env bash
# Copies the shared modules to the MAIN world's own copy of them.
#
# Chrome injects a script file into a document once and the first
# content_scripts entry to list it takes it, world and all — so the page world
# and the isolated world cannot be handed the same file, only the same bytes.
# src/shared is what you edit; src/injected is what the page world loads.
#
# tests/manifest-test.mjs fails if the copies have drifted from their origin.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for name in wire wait; do
  cp "$root/extension/src/shared/$name.js" "$root/extension/src/injected/$name.js"
  echo "src/shared/$name.js → src/injected/$name.js"
done
