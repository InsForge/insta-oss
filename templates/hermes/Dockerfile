# Pinned by digest; the upstream tag floats.
FROM docker.io/nousresearch/hermes-agent:v2026.8.27@sha256:e0df6adebddf29b91112aefc999d4aaf6846c9eb544faca5672a16a13590ff79

# nginx fronts the one port the platform routes, so two listeners can share it: the dashboard, and
# the Telegram webhook server the gateway opens when TELEGRAM_WEBHOOK_URL is set. The webhook path
# must not sit behind the dashboard's sign-in: Telegram authenticates each update with its own
# secret token, never with our username and password. See nginx.conf. Upstream is Debian 13, so
# nginx-light comes from apt like every other package in the image.
RUN apt-get update && apt-get install -y --no-install-recommends nginx-light patch \
    && rm -rf /var/lib/apt/lists/*
COPY nginx.conf /etc/nginx/hermes.conf

# Slack over the inbound Events API. Upstream's Slack adapter speaks Socket Mode only, an outbound
# connection a scale-to-zero platform cannot see; slack_bolt ships an aiohttp request handler for
# the Events API, and this patch wires it in behind SLACK_SIGNING_SECRET plus SLACK_EVENTS_URL,
# leaving Socket Mode as the default when neither is set. Applied against the digest-pinned upstream
# file, so a pin bump that touches the adapter fails this step loudly instead of drifting. Candidate
# for an upstream PR; see slack-events-api.patch for the change itself.
COPY slack-events-api.patch /tmp/slack-events-api.patch
RUN patch -p1 -d /opt/hermes --forward --no-backup-if-mismatch < /tmp/slack-events-api.patch \
    && rm /tmp/slack-events-api.patch \
    && python3 -m py_compile /opt/hermes/plugins/platforms/slack/adapter.py

# Upstream's main process is the interactive TUI, which exits without a TTY. This
# image supplies the main process instead: bootstrap auth, bring up the s6-supervised
# gateway service, then serve the dashboard behind nginx. Upstream's ENTRYPOINT stays: it
# routes an executable through, and on a deployed machine PID 1 is s6-svscan (a 2.1.x note
# here claimed Fly skips s6; observed machines say otherwise), so the s6 service
# tree the entrypoint relies on is present.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
CMD ["/entrypoint.sh"]
