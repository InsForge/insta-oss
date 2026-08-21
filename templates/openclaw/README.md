# OpenClaw

Self-hosted personal AI assistant, reachable from your chat apps.

> **Draft, not deployable yet.** This template is a placeholder: its image reference is
> `pin-at-pr`, not a real tag, and the variable names below are provisional. The registry lint
> rejects the placeholder image, which is why the template is marked draft and stays out of the
> catalog. It needs a pinned image (or a decision to build from the upstream repo) and variable
> names confirmed against upstream's documentation before it can be published.

## Overview

[OpenClaw](https://github.com/openclaw/openclaw) is a personal AI assistant you run yourself.
Upstream describes it as your own personal AI assistant, on any OS and any platform, with your data
staying yours. You reach it from a messaging channel rather than a web chat window.

## What you get by hosting it

- An assistant that runs continuously, rather than only while your machine is on.
- Your model provider key and channel token held as managed secrets.
- A 1 GiB volume mounted at `/data` for assistant state.

## What you need before deploying

- A model provider API key (Anthropic or OpenAI).
- A messaging channel token for the channel you want to use (WhatsApp or Telegram).

Both are provisional: the exact variable names come from upstream's documentation and are not
finalised in this template yet.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `MODEL_API_KEY` | yes | Model provider API key (Anthropic or OpenAI). Exact variable name pending upstream docs. |
| `CHANNEL_TOKEN` | yes | Messaging channel token (WhatsApp or Telegram). Details pending upstream docs. |

The service is declared on port 8080 with a health check on `/`. These, like the image reference,
are provisional until the template is finalised.

## After deploy

Not applicable yet: the template cannot be deployed while its image is a placeholder. Once it is
pinned, the flow will be: open the service URL to confirm it is running, connect your messaging
channel with `CHANNEL_TOKEN`, then message the assistant from that channel.

## Links

- Upstream: <https://github.com/openclaw/openclaw>
- License: MIT (upstream `openclaw/openclaw`; the LICENSE file is the standard MIT text, with
  third-party notices recorded separately in the repository).
