#!/bin/bash
set -e

# No fallback on purpose: the manifest declares both required with no default or generator, so the
# platform always supplies them; inventing one here would hand the agent to whoever finds the URL.
: "${ADMIN_USERNAME:?ADMIN_USERNAME is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

# Handed to `hermes config set` as argv, where a leading dash reads as an option and kills the
# container on a CLI error naming neither this variable nor the operator's typo.
case "$ADMIN_USERNAME" in -*|*$'\n'*)
    echo "entrypoint: refusing to start, ADMIN_USERNAME may not start with a dash or contain a newline" >&2
    exit 1
esac

export HERMES_HOME="${HERMES_HOME:-/data/.hermes}"
mkdir -p "$HERMES_HOME"

# Upstream refuses a non-loopback dashboard bind with no auth provider registered
# (`--insecure` is a documented no-op), so the credential has to exist first.
# `config set` rather than writing config.yaml: the volume survives reboots, and an
# appended YAML block would pile up a copy per boot.
hash="$(cd /opt/hermes && python3 -c 'import sys; from plugins.dashboard_auth.basic import hash_password; print(hash_password(sys.argv[1]))' "$ADMIN_PASSWORD")"
# Output suppressed: `config set` echoes the value, and the hash would land in the
# log tail the console shows.
hermes config set --force dashboard.basic_auth.username "$ADMIN_USERNAME" >/dev/null
hermes config set --force dashboard.basic_auth.password_hash "$hash" >/dev/null

# --skip-build serves the dist baked into the image instead of running npm at boot.
hermes dashboard --host 0.0.0.0 --port "${HERMES_DASHBOARD_PORT:-8080}" --no-open --skip-build &

# --no-supervise: the default hands the gateway to s6 and RETURNS, and s6 is not
# running here.
exec hermes gateway run --no-supervise
