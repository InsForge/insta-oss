#!/bin/sh
# Upstream's entrypoint (root) chowns its own /app/data then drops to node via su-exec; the
# platform volume at /data never gets chowned, which is the EACCES that kept this template draft.
chown -R node:node /data 2>/dev/null || true
exec /entrypoint.sh "$@"
