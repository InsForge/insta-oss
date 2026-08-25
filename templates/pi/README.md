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
- The terminal credentials stored as managed secrets rather than baked into the image.
- Deploys are health-gated: a container that does not answer is rolled back to the last healthy
  image instead of leaving you with a dead URL.

## What you need before deploying

- Nothing mandatory. The sign-in comes prefilled as `admin` / `123456`, which you can change on the
  deploy form.
- A model provider key if you want it present from the first boot. Any one of the three below is
  enough, and none is also fine — you can add a key from inside the terminal instead.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | HTTP basic-auth username for the terminal. Defaults to `admin`. |
| `ADMIN_PASSWORD` | yes | HTTP basic-auth password for the terminal. Defaults to `123456`. |
| `ANTHROPIC_API_KEY` | no | Anthropic key, for Claude models. |
| `OPENAI_API_KEY` | no | OpenAI key, for GPT models. |
| `OPENROUTER_API_KEY` | no | OpenRouter key, for whichever model you route to. |

Pi reads a provider key straight from the environment and picks its model accordingly. It recognises
more than thirty providers (Gemini, DeepSeek, Groq, Mistral, Kimi and so on); the three above are
the ones this template puts on the deploy form, and the rest work just as well as service variables
or configured from inside the terminal.

Set by the template, not by you: `HOME=/data/home` (puts your home directory on the volume).

**Change the password before you share the URL.** The default is the same for every deployment, and
what it protects is a root shell that can run anything and holds whatever API keys you gave it — so
anyone who learns the URL and leaves the default in place has all of that. Both fields are editable
at deploy time and afterwards, from the service's variables.

## After deploy

1. Open the service URL. The browser asks for HTTP basic auth: the `ADMIN_USERNAME` and
   `ADMIN_PASSWORD` you deployed with (`admin` / `123456` unless you changed them).
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
