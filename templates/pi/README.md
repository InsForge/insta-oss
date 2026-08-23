# Pi Coding Agent

Coding agent CLI with session history and a browser terminal.

## Overview

This template runs the [Pi coding agent](https://github.com/earendil-works/pi) inside a container
that exposes a browser terminal. You open a URL, authenticate, and get a `bash` shell with the `pi`
CLI already installed. Upstream describes it as a coding-agent CLI with read, bash, edit and write
tools plus session management: so a session you start now can be picked up later from the same
URL.

The image is built from the Dockerfile in this directory: `node:24-bookworm-slim` (pinned by
digest) plus [ttyd](https://github.com/tsl0922/ttyd) 1.7.7 (verified against a pinned SHA-256) and
`@earendil-works/pi-coding-agent` pinned to an exact version. Nothing floats on `latest`, so a
restart gives you the same environment.

## What you get by hosting it

- An HTTPS URL for the terminal, with no port forwarding or tunnel to manage.
- A 1 GiB volume mounted at `/data`. `HOME` is set to `/data/home`, so session history, CLI config
  and any repositories you clone survive restarts, redeploys and version upgrades.
- The terminal password stored as a managed secret rather than baked into the image.
- Deploys are health-gated: a container that does not answer is rolled back to the last healthy
  image instead of leaving you with a dead URL.

## What you need before deploying

- Nothing mandatory. The access password is generated for you if you leave it blank.
- A model provider key if you want it present from the first boot. Pi accepts keys from several
  providers, and they can also be configured from inside the terminal.
- Optionally, a Git token if you plan to clone private repositories.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ACCESS_PASSWORD` | yes | HTTP basic-auth password for the terminal, username `admin`. Generated (16 chars) when left blank; editable afterwards. |
| `ANTHROPIC_API_KEY` | no | Model provider key available to the CLI at startup. Pi accepts keys from several providers, configurable in the terminal. |

Set by the template, not by you: `HOME=/data/home` (puts your home directory on the volume).

## After deploy

1. Open the service URL. The browser asks for HTTP basic auth: username `admin`, password
   `ACCESS_PASSWORD`. If it was generated, read it from the service's variables.
2. You land in a `bash` shell in `/data/home`.
3. Run `pi`. Configure a model provider key if you did not set one as a variable.
4. Configuration and session history persist. Because `HOME` is on the volume, `~` survives
   restarts, so a session started before a redeploy is still there afterwards.
5. Clone your repository into `/data/home` (or anywhere under `/data`) so your work persists too.
   Files written outside `/data` are lost when the container is replaced.

## Links

- Upstream: <https://github.com/earendil-works/pi>
- Package: [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
- ttyd: <https://github.com/tsl0922/ttyd>
- License: MIT (upstream package).
