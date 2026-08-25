#!/bin/bash
set -e
mkdir -p "$HOME"
cd "$HOME"
# The username falls back to `admin` so the image still runs when pulled without the manifest;
# the password has no fallback on purpose — an unauthenticated root shell must never be reachable.
exec ttyd -p 7681 -W -c "${ADMIN_USERNAME:-admin}:${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}" bash
