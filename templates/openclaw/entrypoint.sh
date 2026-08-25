#!/bin/sh
set -e

# The gateway rejects Control UI connections from origins outside gateway.controlUi.allowedOrigins
# on non-loopback binds; seed the allowlist (or the Host-header fallback) before it starts.
node /seed-origin.mjs || echo "[template] origin seeding failed; the Control UI may reject this origin" >&2

# Approve token-authenticated Control UI devices — the platform has no shell to do it by hand.
node /approve-devices.mjs &

exec node openclaw.mjs gateway --allow-unconfigured --port 8080 --bind lan
