#!/bin/bash
set -e

# Unreachable through the platform: the manifest declares `generate: secret:16`, and
# resolveVariables treats an empty string as not-provided, so a value is always minted.
# This guards a hand-rolled `docker run` that forgot it.
: "${ACCESS_PASSWORD:?ACCESS_PASSWORD is required}"
export HERMES_HOME="${HERMES_HOME:-/data/.hermes}"
mkdir -p "$HERMES_HOME"

# Upstream refuses a non-loopback dashboard bind with no auth provider registered
# (`--insecure` is a documented no-op), so the credential has to exist first.
# `config set` rather than writing config.yaml: the volume survives reboots, and an
# appended YAML block would pile up a copy per boot.
hash="$(cd /opt/hermes && python3 -c 'import sys; from plugins.dashboard_auth.basic import hash_password; print(hash_password(sys.argv[1]))' "$ACCESS_PASSWORD")"
# Output suppressed: `config set` echoes the value, and the hash would land in the
# log tail the console shows.
hermes config set --force dashboard.basic_auth.username admin >/dev/null
hermes config set --force dashboard.basic_auth.password_hash "$hash" >/dev/null

# --skip-build serves the dist baked into the image instead of running npm at boot.
hermes dashboard --host 0.0.0.0 --port "${HERMES_DASHBOARD_PORT:-8080}" --no-open --skip-build &

# --no-supervise: the default hands the gateway to s6 and RETURNS, and s6 is not
# running here.
exec hermes gateway run --no-supervise
