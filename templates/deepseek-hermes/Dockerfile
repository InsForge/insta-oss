# Pinned by digest; the upstream tag floats.
FROM docker.io/nousresearch/hermes-agent:v2026.8.16@sha256:f8f548d87d16634d1ad9e3777280f3f577ba2358703f04e18e74007ffd3621bf

# Upstream's main process is the interactive TUI, which exits without a TTY. Under
# a normal `docker run` s6 is PID 1 and supervises the gateway anyway; on Fly the
# platform's init is PID 1, the image skips s6, and only the main process runs,
# so the TUI exits 0 and nothing ever binds a port. This image supplies the main
# process instead. Upstream's ENTRYPOINT stays: it routes an executable through.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
CMD ["/entrypoint.sh"]
