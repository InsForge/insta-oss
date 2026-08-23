#!/bin/bash
# pipefail is load-bearing: without it a failed `openssl passwd` still writes a usable-looking
# htpasswd, and the platform's `healthcheck: /` reads the resulting blanket 401 as healthy.
set -euo pipefail

# Unreachable through the platform, which always mints a value. Guards a hand-rolled docker run.
: "${ACCESS_PASSWORD:?ACCESS_PASSWORD is required}"

export HOME="${HOME:-/data/home}"
export DSH_HOME="${DSH_HOME:-/data/dsh}"

# Fixed, not configurable: it is the sandbox policy's workspaceRoot and the key sessions are
# indexed by under $DSH_HOME, so moving it between boots orphans the history.
mkdir -p "$HOME" "$DSH_HOME" /data/workspace /run/dsh

# Regenerated every boot so rotating ACCESS_PASSWORD takes effect on restart.
# On stdin, not argv, to keep the password out of the process list.
printf '%s' "$ACCESS_PASSWORD" | openssl passwd -apr1 -stdin \
    | sed 's|^|admin:|' > /run/dsh/htpasswd
chown root:www-data /run/dsh/htpasswd
chmod 640 /run/dsh/htpasswd

# Belt to pipefail's braces: a truncated hash would gate nothing and still look like a file.
if ! grep -q '^admin:\$apr1\$' /run/dsh/htpasswd; then
    echo "entrypoint: refusing to start, htpasswd does not hold an apr1 hash" >&2
    exit 1
fi

# The credential nginx accepts on a WebSocket handshake, for the reason nginx.conf gives: no
# header can be set on `new WebSocket()`, and not every engine attaches the basic credentials.
# Derived from the password, so a cookie survives a restart and dies when the password rotates.
GATE_TOKEN="$(printf 'dsh-gate-cookie-v1:%s' "$ACCESS_PASSWORD" | openssl dgst -sha256 -r | cut -d' ' -f1)"

# Fail closed: an empty token would land as an empty map key, which is what $gate_upgrade holds
# for every ordinary request, and would read as "no password required" for the whole site.
if [[ ! "$GATE_TOKEN" =~ ^[0-9a-f]{64}$ ]]; then
    echo "entrypoint: refusing to start, gate token is not a sha256 hex digest" >&2
    exit 1
fi

# Rendered into /run, so the shipped template stays the file a reader can trust and the token
# never lands in an image layer. Root-only: it is password-equivalent.
sed "s|__DSH_GATE_TOKEN__|$GATE_TOKEN|g" /etc/nginx/nginx.conf.template > /run/dsh/nginx.conf
chmod 600 /run/dsh/nginx.conf
if grep -q '__DSH_GATE_TOKEN__' /run/dsh/nginx.conf; then
    echo "entrypoint: refusing to start, gate token placeholder survived rendering" >&2
    exit 1
fi

# Neither process needs the plaintext from here on, and dsh runs shell commands the model chooses,
# so anything it spawns would otherwise inherit the gate password.
unset ACCESS_PASSWORD

# Checked before it is started, so a config nginx will not load exits with nginx's own message
# rather than leaving dsh running behind a dead port.
nginx -t -c /run/dsh/nginx.conf

cd /data/workspace

# 127.0.0.1 is upstream's rule, not a workaround: `--host 0.0.0.0` is refused by design because
# the UI drives an agent that runs commands and has no auth (bundle/web-app/src/startup.ts).
nginx -c /run/dsh/nginx.conf -g 'daemon off;' &
nginx_pid=$!
dsh web --host 127.0.0.1 --port 3080 --no-open &
dsh_pid=$!

# Both halves are fatal. Backgrounding nginx under `exec dsh` used to mean a dead nginx left the
# container up with an unreachable URL, which reads as a mystery timeout instead of a failure.
stopping=""
trap 'stopping=1; kill -TERM "$nginx_pid" "$dsh_pid" 2>/dev/null || true' TERM INT
wait -n || true

# A signal is an orderly stop, so only a child dying on its own is a failure.
if [[ -n "$stopping" ]]; then
    exit 0
fi
echo "entrypoint: nginx or dsh exited, stopping the container" >&2
exit 1
