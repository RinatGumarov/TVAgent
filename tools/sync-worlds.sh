#!/usr/bin/env bash
# Copies the shared modules to the page world, which cannot load the same file.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for name in wire wait; do
  cp "$root/extension/src/shared/$name.js" "$root/extension/src/injected/$name.js"
  echo "src/shared/$name.js → src/injected/$name.js"
done
