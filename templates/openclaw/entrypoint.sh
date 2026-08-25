#!/bin/sh
set -e

# The gateway rejects Control UI connections from origins outside gateway.controlUi.allowedOrigins
# on non-loopback binds, so seed this environment's public URL into the list before starting.
if [ -n "$OPENCLAW_PUBLIC_URL" ]; then
  node /seed-origin.mjs || echo "origin seeding failed; the Control UI may reject this origin" >&2
fi

exec node openclaw.mjs gateway --allow-unconfigured --port 8080 --bind lan
