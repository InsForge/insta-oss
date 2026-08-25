# Pinned by digest; upstream's dated version tags stalled at 2026.3.1, so latest (2026.7.1-1) is the pin source.
FROM ghcr.io/openclaw/openclaw:latest@sha256:2f5ce8848a1a69b3c460622e566cb9395da9fd18d7ef7b038cd8e2c4f195decf

# Upstream's CMD is `gateway` alone: on a fresh volume with no openclaw.json it exits before
# binding, and it listens on loopback where the platform proxy cannot reach it. The manifest
# has no command override, so this image carries the flags. Upstream's ENTRYPOINT stays.
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured", "--port", "8080", "--bind", "lan"]
