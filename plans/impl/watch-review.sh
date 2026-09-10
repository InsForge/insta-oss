#!/bin/bash
# Watch PR 97 for review activity after the request cutoff. Both bots review as
# jwfing, so count reviews after the cutoff rather than distinct authors.
CUTOFF="2026-09-10T05:23:00Z"
prev=""
while true; do
  s=$(gh pr view 97 --repo InsForge/insta-oss --json reviews,reviewDecision 2>/dev/null || true)
  cur=$(printf '%s' "$s" | jq -r --arg c "$CUTOFF" '[.reviews[] | select(.submittedAt > $c) | "\(.state)@\(.submittedAt)"] | sort | join(" ")' 2>/dev/null)
  if [ -n "$cur" ] && [ "$cur" != "$prev" ]; then
    echo "new review: $cur | decision: $(printf '%s' "$s" | jq -r .reviewDecision)"
  fi
  prev="$cur"
  n=$(printf '%s' "$s" | jq -r --arg c "$CUTOFF" '[.reviews[] | select(.submittedAt > $c)] | length' 2>/dev/null)
  if [ "${n:-0}" -ge 2 ]; then echo "ROUND-COMPLETE both bots responded"; break; fi
  sleep 30
done
