#!/bin/bash
set -e
mkdir -p "$HOME"
cd "$HOME"
# The username falls back to `admin` so the image still runs when pulled without the manifest.
# The password gets no fallback on purpose: an unauthenticated root shell must never be reachable,
# so an unset or empty ADMIN_PASSWORD fails the container instead.
CRED="${ADMIN_USERNAME:-admin}:${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"
# ttyd 1.7.7 quietly stops matching the credential once "user:pass" passes 186 bytes. It starts
# normally and then answers 401 to everyone, the owner included, logging nothing; the health check
# reads that 401 as alive, so the deploy reports success and the terminal is unreachable for good.
# Measured against this image: 186 bytes authenticates, 187 does not. Fail loudly instead.
# Bytes, not characters: ${#CRED} counts characters, which differ under a non-C locale.
CRED_BYTES=$(printf '%s' "$CRED" | wc -c)
if [ "$CRED_BYTES" -gt 186 ]; then
  echo "ADMIN_USERNAME:ADMIN_PASSWORD is $CRED_BYTES bytes; ttyd accepts at most 186" >&2
  exit 1
fi
exec ttyd -p 7681 -W -c "$CRED" bash
