#!/bin/bash
set -e

# No fallback on purpose: the manifest declares both required with no default or generator, so the
# platform always supplies them; inventing one here would hand the agent to whoever finds the URL.
: "${ADMIN_USERNAME:?ADMIN_USERNAME is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

# Two different failures, both silent without this. A colon can never reach the dashboard: basic
# auth sends `user:password` and the server splits on the FIRST one, so `alice:ops` is unpresentable
# at the browser prompt while the deploy goes green (the health probe fetches /api/status, which is
# not behind the auth). A leading dash is read as an option by `hermes config set`, which takes this
# as argv, and kills the container on a CLI error naming neither the variable nor the typo.
case "$ADMIN_USERNAME" in *:*|-*|*$'\n'*)
    echo "entrypoint: refusing to start, ADMIN_USERNAME may not contain a colon or a newline, or start with a dash" >&2
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

# The gateway runs as the s6-supervised gateway-default service, NOT as this script's
# child. The platform hands the image PID 1, so s6-overlay is live (a 2.1.x comment
# claiming Fly skips it was wrong: PID 1 on a deployed machine is s6-svscan) and
# `hermes gateway start` dispatches to s6, bringing the slot up. That slot is the same
# one the dashboard's Channels-page "Restart gateway" and System-page buttons drive
# through s6-svc, so channel changes apply repeatedly and a crashed gateway is
# respawned by s6, both upstream-owned behaviors. In the 2.1.x layout the gateway was
# the main process instead, and those buttons fought it: a restart either exited the
# container or left a detached gateway the dashboard could no longer manage.
# Zero configured channels is fine: the gateway idles and browser chat still works.
#
# First boot ONLY: upstream's boot reconciliation replays the operator's persisted
# intent from ${HERMES_HOME}/gateway_state.json (running comes back up, an explicit
# dashboard Stop stays down), and s6 lifecycle commands write that file. Starting
# unconditionally here would overwrite a persisted Stop on every container restart,
# silently reconnecting messaging channels the operator turned off. The seed exists so
# a fresh deploy connects its deploy-time channel variables without a dashboard visit.
# Non-fatal on purpose: in a runtime without s6 this prints guidance and exits 0, the
# dashboard still serves, and channels can wait for a start from the System page.
if [ ! -f "${HERMES_HOME}/gateway_state.json" ]; then
  hermes gateway start || echo "entrypoint: gateway start failed; start it from the dashboard's System page" >&2
fi

# Telegram arrives over an INBOUND webhook when the manifest's TELEGRAM_WEBHOOK_URL is in the
# environment (the gateway registers the URL with Telegram itself on connect). The gateway's
# webhook server listens on loopback and nginx publishes it at /telegram on the routed port, next
# to the dashboard. An inbound update is traffic the platform can see and wake a machine for; the
# long poll upstream defaults to is not. Slack gets the same treatment: the adapter patched in the
# Dockerfile serves Slack's Events API on loopback and nginx publishes it at /slack/events (this
# image offers no Socket Mode). The Discord gateway is still an outbound connection, so a Discord
# deployment has to turn always-on on in the console: see the README's scale-to-zero section.
# Nothing here depends on a channel token being set: without one the adapter never starts and
# these variables are inert.

# Upstream's s6 runs this script as the unprivileged hermes user, so nginx gets its pid file and
# temp directories under /tmp (nginx.conf points there); /run and /var/lib/nginx are root's.
mkdir -p /tmp/hermes-nginx

# Checked before anything starts, so a config nginx will not load fails the boot with nginx's own
# message instead of leaving the dashboard up behind a dead port.
nginx -t -c /etc/nginx/hermes.conf

# Both processes are children of this script, which is the s6 CMD service's main process. Either
# dying is fatal: s6 then reruns this script, which is idempotent (the config writes above use
# --force and the gateway seed checks its own marker). Backgrounding nginx under an exec'd dashboard
# would instead leave a dead nginx unnoticed behind a healthy-looking container.
# --skip-build serves the dist baked into the image instead of running npm at boot.
nginx -c /etc/nginx/hermes.conf -g 'daemon off;' &
nginx_pid=$!
# 0.0.0.0, NOT 127.0.0.1, even though only nginx on this machine ever connects: upstream treats a
# loopback bind as a trusted local operator and switches its sign-in gate OFF (auth_required=false,
# the SPA served to anyone), which behind a public reverse proxy is an open dashboard. A
# non-loopback bind keeps the gate on, exactly as 2.3.x had it. The port is not one the platform
# routes, so nothing but nginx reaches it anyway.
hermes dashboard --host 0.0.0.0 --port "${HERMES_DASHBOARD_PORT:-8081}" --no-open --skip-build &
dashboard_pid=$!

# A signal is an orderly stop (s6 sends TERM on stop and on the platform's suspend), so only a
# child dying on its own is a failure.
stopping=""
trap 'stopping=1; kill -TERM "$nginx_pid" "$dashboard_pid" 2>/dev/null || true' TERM INT
wait -n || true
if [[ -n "$stopping" ]]; then
  wait || true
  exit 0
fi
echo "entrypoint: nginx or the dashboard exited on its own, restarting the service" >&2
kill -TERM "$nginx_pid" "$dashboard_pid" 2>/dev/null || true
exit 1
