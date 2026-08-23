# Codex

OpenAI's lightweight coding agent in a browser terminal.

## Overview

This template runs [Codex](https://github.com/openai/codex), OpenAI's terminal coding agent,
inside a container that exposes a browser terminal. You open a URL, authenticate, and get a `bash`
shell with the `codex` CLI already installed. Upstream describes it as a lightweight coding agent
that runs in your terminal; this template gives that terminal a URL and a disk.

The image is built from the Dockerfile in this directory: `node:24-bookworm-slim` (pinned by
digest) plus [ttyd](https://github.com/tsl0922/ttyd) 1.7.7 (verified against a pinned SHA-256) and
`@openai/codex` pinned to an exact version. Nothing floats on `latest`, so a restart gives you the
same environment.

## What you get by hosting it

- An HTTPS URL for the terminal, with no port forwarding or tunnel to manage.
- A 1 GiB volume mounted at `/data`. `HOME` is set to `/data/home`, so your CLI login, shell
  history, and any repositories you clone survive restarts, redeploys, and version upgrades.
- The terminal password stored as a managed secret rather than baked into the image.
- Deploys are health-gated: a container that does not answer is rolled back to the last healthy
  image instead of leaving you with a dead URL.

## What you need before deploying

- Nothing mandatory. The access password is generated for you if you leave it blank.
- Optionally, an [OpenAI API key](https://platform.openai.com/api-keys): otherwise you sign in
  from inside the terminal with `codex login`.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ACCESS_PASSWORD` | yes | HTTP basic-auth password for the terminal, username `admin`. Generated (16 chars) when left blank; editable afterwards. |
| `OPENAI_API_KEY` | no | Authenticates the CLI without an interactive login. Leave blank to run `codex login` in the terminal instead. |

Set by the template, not by you: `HOME=/data/home` (puts your home directory on the volume).

## After deploy

1. Open the service URL. The browser asks for HTTP basic auth: username `admin`, password
   `ACCESS_PASSWORD`. If it was generated, read it from the service's variables.
2. You land in a `bash` shell in `/data/home`.
3. Run `codex`. If you did not set `OPENAI_API_KEY`, run `codex login` first and follow the
   prompts.
4. That login persists. Because `HOME` is on the volume, the CLI's config survives restarts: you
   do not re-authenticate after every deploy.
5. Clone your repository into `/data/home` (or anywhere under `/data`) so your work persists too.
   Files written outside `/data` are lost when the container is replaced.

## Links

- Upstream: <https://github.com/openai/codex>
- Package: [`@openai/codex`](https://www.npmjs.com/package/@openai/codex)
- ttyd: <https://github.com/tsl0922/ttyd>
- License: Apache-2.0 (upstream `openai/codex`).
