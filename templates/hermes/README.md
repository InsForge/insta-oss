# Hermes Agent

Autonomous AI agent from Nous Research, driven from Telegram.

## Overview

This template runs [Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research.
Hermes is an autonomous agent: you send it a task over Telegram, and it works on it with its own
tools rather than answering a single prompt. The template wraps the upstream image with a start
command (upstream's default process is an interactive terminal UI that exits without a TTY) and
runs the messaging gateway with the web dashboard beside it, state on a persistent volume.

The dashboard is what the service URL serves; Telegram is how you give the agent work.

## What you get by hosting it

- An HTTPS URL for the Hermes dashboard, behind a password (username `admin`), with no port
  forwarding or tunnel to manage. Upstream refuses to expose the dashboard without one.
- A 1 GiB volume mounted at `/data`, with `HERMES_HOME` pointed at `/data/.hermes` so the agent's
  state survives restarts and redeploys.
- The gateway token generated for you (64 chars) and stored as a managed secret, so it is never
  committed anywhere or shown in the manifest.
- Your API keys and bot token held as managed secrets rather than baked into an image.
- Deploys are health-gated against `/api/status`, so a container that never becomes ready is rolled
  back rather than left serving errors.

## What you need before deploying

- An [OpenRouter API key](https://openrouter.ai/keys). The agent calls models through OpenRouter.
- A Telegram bot token, created with [@BotFather](https://t.me/BotFather): send `/newbot`, pick a
  name and a username ending in `bot`, and it replies with the token.
- The Telegram usernames allowed to use the bot. Yours is under Settings in any Telegram client,
  **without** the leading `@`. Comma-separate several. Without this the bot has no authorised users.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ACCESS_PASSWORD` | generated | Dashboard password for `admin`; blank mints one. |
| `OPENROUTER_API_KEY` | yes | Key the agent uses for model calls. Get one at <https://openrouter.ai/keys>. |
| `TELEGRAM_BOT_TOKEN` | yes | Token for the bot that receives your tasks. Create the bot with @BotFather. |
| `TELEGRAM_ALLOWED_USERS` | yes | Comma-separated Telegram usernames allowed to use the bot. |
| `HERMES_GATEWAY_TOKEN` | generated | Generated 64-character token; you do not set this. |

Set by the template, not by you: `HERMES_HOME=/data/.hermes` (state on the volume) and
`HERMES_DASHBOARD_PORT=8080`. The entrypoint binds the dashboard and runs the gateway.

## After deploy

1. Wait for the health check on `/api/status` to pass, then open the service URL to reach the
   dashboard.
2. Open Telegram and message your bot from one of the usernames in `TELEGRAM_ALLOWED_USERS`.
   Messages from anyone else are ignored.
3. Give the agent a task in the chat. Progress and history are visible in the dashboard.
4. State lives under `/data/.hermes`, so restarts and redeploys keep the agent's memory. Deleting
   the volume resets it.

## Links

- Documentation: <https://hermes-agent.nousresearch.com/docs/>
- Upstream: <https://github.com/NousResearch/hermes-agent>
- Image: `docker.io/nousresearch/hermes-agent`, pinned to `v2026.8.16`
- License: MIT (upstream `NousResearch/hermes-agent`).
