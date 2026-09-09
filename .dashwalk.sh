#!/bin/bash
B=/Users/gary/.claude/skills/gstack/browse/dist/browse
BASE=https://console.34-207-169-54.sslip.io
P=2417888d-3805-4dd4-82f9-003956aecef1
for path in "$@"; do
  echo "===== $path ====="
  $B goto "$BASE$path" 2>&1 | grep -v "^warn\|bun-darwin" | tail -1
  $B wait --networkidle 2>&1 | tail -1 > /dev/null
  $B text 2>&1 | grep -v "^warn\|bun-darwin\|BEGIN UNTRUSTED\|END UNTRUSTED" | head -c 900
  echo
  echo "--- console errors ---"
  $B console --errors 2>&1 | grep -v "^warn\|bun-darwin\|BEGIN UNTRUSTED\|END UNTRUSTED" | head -c 500
  echo
done
