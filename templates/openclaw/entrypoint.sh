#!/bin/sh
set -e

# The gateway rejects Control UI connections from origins outside gateway.controlUi.allowedOrigins
# on non-loopback binds; seed the allowlist (or the Host-header fallback) before it starts. A
# seeding failure fails startup: a gateway whose UI rejects every browser is not healthy. The one
# deliberate skip — an existing config the script cannot parse — exits 0 inside seed-origin.mjs.
node /seed-origin.mjs

# Approve token-authenticated Control UI devices — the platform has no shell to do it by hand.
node /approve-devices.mjs &

exec node openclaw.mjs gateway --allow-unconfigured --port 8080 --bind lan
