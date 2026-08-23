# Base pinned by digest (multi-arch OCI index: linux/amd64 + linux/arm64): tags float.
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

# nginx: the auth gate and the only thing that faces the network, because the harness web UI
# ships no authentication of its own. openssl hashes the password for nginx at boot.
# bubblewrap is load-bearing, not optional: the harness runs every shell command through a
# sandbox and falls back to failing closed when it has no runner. Its Landlock runner probes
# "unusable" on Fly's kernel (verified in a deployed container on 6.12.91-fly), which leaves
# bwrap as the only one that works there. Without it the agent cannot run a single command.
# git, curl and procps are for the agent's own shell work. ripgrep is NOT installed: the
# harness bundles its own through @vscode/ripgrep.
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash git ca-certificates curl procps nginx-light openssl bubblewrap \
    && rm -rf /var/lib/apt/lists/*

# pnpm is how `dsh plugin add` installs plugins into a profile, which is the whole point of a
# harness whose tagline is "Everything is a Plugin". 10 or newer: the profile pnpm-workspace.yaml
# dsh writes carries `nodeLinker`, which older pnpm reads from .npmrc instead.
ARG PNPM_VERSION=11.22.0
RUN npm install -g pnpm@${PNPM_VERSION}

# upstream pin: keep in sync with insta.template.yaml (upstream.pinned)
ARG DSH_VERSION=0.1.1-rc.2
RUN npm install -g @deepseek-ai/dsh@${DSH_VERSION}

# The grep and glob tools resolve ripgrep from an optional per-platform package, and a missing
# optional dependency is silent at install and only fails when the model calls the tool. Fail
# the build instead. `dsh --version` separately proves the bin and its 450+ deps load at all.
RUN dsh --version
RUN rg_bin="$(find "$(npm root -g)" -type f -path '*@vscode/ripgrep-*/bin/rg' -print -quit)" \
    && test -n "$rg_bin" && test -x "$rg_bin" \
    && echo "bundled ripgrep: $rg_bin"

COPY nginx.conf /etc/nginx/nginx.conf
RUN nginx -t

ENV HOME=/data/home
ENV DSH_HOME=/data/dsh

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8080
CMD ["/entrypoint.sh"]
