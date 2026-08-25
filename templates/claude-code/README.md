# Claude Code

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
- The terminal credentials stored as managed secrets rather than baked into the image.
- Deploys are health-gated: a container that does not answer is rolled back to the last healthy
  image instead of leaving you with a dead URL.

## What you need before deploying

- Nothing mandatory. The sign-in comes prefilled as `admin` / `123456`, which you can change on the
  deploy form.
- Optionally, an [Anthropic API key](https://console.anthropic.com/): otherwise you sign in from
  inside the terminal with `claude login`, which is the normal path for a Claude subscription.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | HTTP basic-auth username for the terminal. Defaults to `admin`. |
| `ADMIN_PASSWORD` | yes | HTTP basic-auth password for the terminal. Defaults to `123456`. |
| `ANTHROPIC_API_KEY` | no | Authenticates the CLI without an interactive login. Leave blank to run `claude login` in the terminal instead. |

Set by the template, not by you: `HOME=/data/home` (puts your home directory on the volume).

**Change the password before you share the URL.** The default is the same for every deployment, and
what it protects is a root shell that can run anything and holds whatever API keys you gave it — so
anyone who learns the URL and leaves the default in place has all of that. Both fields are editable
at deploy time and afterwards, from the service's variables.

## After deploy

1. Open the service URL. The browser asks for HTTP basic auth: the `ADMIN_USERNAME` and
   `ADMIN_PASSWORD` you deployed with (`admin` / `123456` unless you changed them).
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
