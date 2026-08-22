# DeepSeek Hermes

Hermes Agent preconfigured for DeepSeek models.

## Overview

This is the [Hermes Agent](../hermes/) template with DeepSeek as the default model. It runs the
same image, wrapped with the same start command, with `HERMES_DEFAULT_MODEL` set to
`deepseek/deepseek-chat` so you do not have to pick a model after deploying. Everything else,
the Telegram interface, the dashboard and the persistent state, is identical.

Pick this one if you want DeepSeek; pick plain Hermes Agent if you want to choose the model
yourself.

## What you get by hosting it

- An HTTPS URL for the Hermes dashboard, behind a password (username `admin`), with no port
  forwarding or tunnel to manage. Upstream refuses to expose the dashboard without one.
- A 1 GiB volume mounted at `/data`, with `HERMES_HOME` pointed at `/data/.hermes` so the agent's
  state survives restarts and redeploys.
- The gateway token generated for you (64 chars) and stored as a managed secret.
- One less decision at deploy time: the default model is already set.
- Deploys are health-gated against `/api/status`, so a container that never becomes ready is rolled
  back rather than left serving errors.

## What you need before deploying

- An [OpenRouter API key](https://openrouter.ai/keys). DeepSeek models are served through
  OpenRouter, so this is the only provider key you need.
- A Telegram bot token, created with [@BotFather](https://t.me/BotFather): send `/newbot`, pick a
  name and a username ending in `bot`, and it replies with the token.
- The Telegram usernames allowed to use the bot. Yours is under Settings in any Telegram client,
  **without** the leading `@`. Comma-separate several. Without this the bot has no authorised users.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ACCESS_PASSWORD` | generated | Dashboard password for `admin`; blank mints one. |
| `OPENROUTER_API_KEY` | yes | Key the agent uses for model calls; DeepSeek is served through OpenRouter. |
| `TELEGRAM_BOT_TOKEN` | yes | Token for the bot that receives your tasks. Create the bot with @BotFather. |
| `TELEGRAM_ALLOWED_USERS` | yes | Comma-separated Telegram usernames allowed to use the bot. |
| `HERMES_GATEWAY_TOKEN` | generated | Generated 64-character token; you do not set this. |

Set by the template, not by you: `HERMES_DEFAULT_MODEL=deepseek/deepseek-chat`,
`HERMES_HOME=/data/.hermes` and `HERMES_DASHBOARD_PORT=8080`; the entrypoint binds the dashboard.

## After deploy

1. Wait for the health check on `/api/status` to pass, then open the service URL to reach the
   dashboard.
2. Message your bot on Telegram from one of the allowed usernames.
3. Give the agent a task. It uses DeepSeek unless you change the model.
4. State lives under `/data/.hermes`, so restarts and redeploys keep the agent's memory.

## Links

- Documentation: <https://hermes-agent.nousresearch.com/docs/>
- Upstream: <https://github.com/NousResearch/hermes-agent>
- Image: `docker.io/nousresearch/hermes-agent`, pinned to `v2026.8.16`
- Models: <https://openrouter.ai/deepseek>
- License: MIT (upstream `NousResearch/hermes-agent`).
