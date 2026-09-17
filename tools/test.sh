#!/usr/bin/env bash
# Runs every test under tests/.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root/tests"

tests=(
  manifest-test.mjs
  provider-url-test.mjs
  worker-gates-test.mjs
  wire-test.mjs
  bridge-test.mjs
  probe-test.mjs
  widgetbar-test.mjs
  agent-test.mjs
  chat-test.mjs
  mount-test.mjs
  panel-test.mjs
  settings-screen-test.mjs
  settings-test.mjs
  models-test.mjs
)

failed=()
for t in "${tests[@]}"; do
  [ -f "$t" ] || continue
  printf '\n═══ %s ═══\n' "$t"
  node "$t" || failed+=("$t")
done

printf '\n'
if [ ${#failed[@]} -eq 0 ]; then
  echo "all suites green"
else
  printf 'FAILED: %s\n' "${failed[*]}"
  exit 1
fi
