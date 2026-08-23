# Claude Code

[![Deploy on InstaCloud](https://www.instacloud.com/deploy-badge.svg)](https://www.instacloud.com/templates/claude-code)

Anthropic's coding agent: edits files, runs commands, browser terminal.

## Overview

This template runs [Claude Code](https://github.com/anthropics/claude-code), Anthropic's terminal
coding agent, inside a container that exposes a browser terminal. You open a URL, authenticate, and
get a `bash` shell with the `claude` CLI already installed: no local install, no laptop left
running. Claude Code reads and edits files in the workspace, runs commands, and works through
multi-step tasks in the same session.

The image is built from the Dockerfile in this directory: `node:24-bookworm-slim` (pinned by
digest) plus [ttyd](https://github.com/tsl0922/ttyd) 1.7.7 (verified against a pinned SHA-256) and
`@anthropic-ai/claude-code` pinned to an exact version. Nothing floats on `latest`, so a restart
gives you the same environment.

## What you get by hosting it

- An HTTPS URL for the terminal, with no port forwarding or tunnel to manage.
- A 1 GiB volume mounted at `/data`. `HOME` is set to `/data/home`, so your CLI login, shell
  history, and any repositories you clone survive restarts, redeploys, and version upgrades.
- The terminal password stored as a managed secret rather than baked into the image.
- Deploys are health-gated: a container that does not answer is rolled back to the last healthy
  image instead of leaving you with a dead URL.

## What you need before deploying

- Nothing mandatory. The access password is generated for you if you leave it blank.
- Optionally, an [Anthropic API key](https://console.anthropic.com/): otherwise you sign in from
  inside the terminal with `claude login`, which is the normal path for a Claude subscription.
- Optionally, a Git token if you plan to clone private repositories.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ACCESS_PASSWORD` | yes | HTTP basic-auth password for the terminal, username `admin`. Generated (16 chars) when left blank; editable afterwards. |
| `ANTHROPIC_API_KEY` | no | Authenticates the CLI without an interactive login. Leave blank to run `claude login` in the terminal instead. |
| `GIT_TOKEN` | no | Token for cloning private Git repositories. |

Set by the template, not by you: `HOME=/data/home` (puts your home directory on the volume).

## After deploy

1. Open the service URL. The browser asks for HTTP basic auth: username `admin`, password
   `ACCESS_PASSWORD`. If it was generated, read it from the service's variables.
2. You land in a `bash` shell in `/data/home`.
3. Run `claude`. If you did not set `ANTHROPIC_API_KEY`, run `claude login` first and follow the
   prompts.
4. That login persists. Because `HOME` is on the volume, `~/.claude` survives restarts: you do not
   re-authenticate after every deploy.
5. Clone your repository into `/data/home` (or anywhere under `/data`) so your work persists too.
   Files written outside `/data` are lost when the container is replaced.

## Links

- Documentation: <https://code.claude.com/docs>
- Upstream: <https://github.com/anthropics/claude-code>
- Package: [`@anthropic-ai/claude-code`](https://www.npmjs.com/package/@anthropic-ai/claude-code)
- ttyd: <https://github.com/tsl0922/ttyd>
- License: Claude Code is distributed under Anthropic's commercial terms, not an open-source
  license. The Dockerfile and manifest in this directory are part of this repository.
