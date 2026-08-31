# Pinned by digest; the upstream tag floats.
FROM docker.io/nousresearch/hermes-agent:v2026.8.16@sha256:f8f548d87d16634d1ad9e3777280f3f577ba2358703f04e18e74007ffd3621bf

# Upstream's main process is the interactive TUI, which exits without a TTY. This
# image supplies the main process instead: bootstrap auth, bring up the s6-supervised
# gateway service, then serve the dashboard. Upstream's ENTRYPOINT stays: it routes
# an executable through, and on a deployed machine PID 1 is s6-svscan (a 2.1.x note
# here claimed Fly skips s6; observed machines say otherwise), so the s6 service
# tree the entrypoint relies on is present.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
CMD ["/entrypoint.sh"]
