# 9Router

Self-hosted LLM router with fallback across 40+ providers.

> **Draft, not published.** This template is not in the catalog yet. The container runs, but it
> cannot persist its data on this platform: the volume is mounted root-owned at `/data` while the
> app runs as a non-root user, so nothing it writes lands on the volume. Details and the full
> evidence are in [QA.md](../QA.md), finding 4. That volume-ownership issue is the only thing
> keeping this template out of the catalog; the fix belongs in the platform.

## Overview

[9Router](https://github.com/decolua/9router) is a self-hosted gateway that sits between your
coding tools and multiple model providers. You point Claude Code, Codex, Cursor, Cline or any
OpenAI-compatible client at one endpoint, and 9Router routes each request to a provider: falling
back to another when one is unavailable or rate-limited. Upstream advertises routing across 40+
providers with automatic fallback.

This template deploys the official upstream image unchanged.

## What you get by hosting it

- One HTTPS endpoint your tools point at, instead of provider-specific configuration in each tool.
- Provider keys held in one place that you control.
- No required variables at deploy time: providers are configured in the app's own UI afterwards.

## What you need before deploying

- Nothing at deploy time: the template declares no required variables.
- Provider accounts and API keys for whichever providers you intend to route to. You add these in
  the app after it starts.

## Configuration

This template declares no required, optional or generated variables: everything is configured in
the app's own interface after deploy. The service listens on port 20128 and is health-checked on
`/`.

## After deploy

1. Open the service URL.
2. Add your provider keys in the app's interface.
3. Point your tools at the service URL as their OpenAI-compatible base URL.
4. **Persistence caveat while this template is draft:** configuration written by the app does not
   currently land on the volume, so it will not survive a restart. This is the reason the template
   is not published: see [QA.md](../QA.md), finding 7.

## Links

- Upstream: <https://github.com/decolua/9router>
- Image: `docker.io/decolua/9router`, pinned to `0.5.55`
- License: MIT (upstream `decolua/9router`).
