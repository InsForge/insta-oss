#!/bin/bash
set -e

# Unreachable through the platform: the manifest declares `generate: secret:16`, and
# resolveVariables treats an empty string as not-provided, so a value is always minted.
# This guards a hand-rolled `docker run` that forgot it.
: "${ACCESS_PASSWORD:?ACCESS_PASSWORD is required}"

export HOME="${HOME:-/data/home}"
export DSH_HOME="${DSH_HOME:-/data/dsh}"

# /data/workspace is where the agent's files go. The path is fixed rather than configurable
# because it is load-bearing twice over: it is the sandbox policy's workspaceRoot, and sessions
# are indexed under $DSH_HOME/sessions by it, so moving it between boots orphans the history.
mkdir -p "$HOME" "$DSH_HOME" /data/workspace /run/dsh

# Regenerated every boot so rotating ACCESS_PASSWORD takes effect on restart. Piped rather
# than passed as an argument to keep the password out of the process list. Owned by root and
# readable by the nginx worker user, which is what reads it.
printf '%s' "$ACCESS_PASSWORD" | openssl passwd -apr1 -stdin \
    | sed 's|^|admin:|' > /run/dsh/htpasswd
chown root:www-data /run/dsh/htpasswd
chmod 640 /run/dsh/htpasswd

nginx -g 'daemon off;' &

cd /data/workspace

# 127.0.0.1 is upstream's own rule, not a workaround: `--host 0.0.0.0` is refused by design
# because the web UI drives an agent that runs commands and has no authentication
# (packages/bundle/web-app/src/startup.ts). nginx is what faces the network.
exec dsh web --host 127.0.0.1 --port 3080 --no-open
