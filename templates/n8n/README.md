# n8n

Visual workflow automation with 400+ integrations.

> **Draft, not published.** This template declares a managed `postgres` service, and the current
> platform template executor deploys web services only, so publishing it is rejected. See
> [QA.md](../QA.md), finding 8. It will be published once the managed-database service type is
> supported in a template manifest.

## Overview

[n8n](https://github.com/n8n-io/n8n) is a workflow automation tool: you build flows on a canvas,
connecting apps and APIs, and drop into code only where you need it. Upstream describes it as
fair-code workflow automation with native AI capabilities and 400+ integrations.

This template deploys the official upstream image unchanged, alongside a managed PostgreSQL
database for n8n's own storage, and points n8n's data directory at a persistent volume.

## What you get by hosting it

- An HTTPS URL for the n8n editor, with no port forwarding or tunnel to manage.
- A managed PostgreSQL database, with its connection string injected by the platform rather than
  configured by hand.
- A 1 GiB volume mounted at `/data`, with `N8N_USER_FOLDER` pointed at it.
- The encryption key generated for you (32 chars) and stored as a managed secret. n8n uses it to
  encrypt stored credentials, so it must not change between deploys.
- Your workflows and credentials on infrastructure you control, rather than a hosted tier.

## What you need before deploying

- Nothing at deploy time: the template declares no required variables. n8n runs its own
  owner-setup wizard on first visit, where you create the admin account.
- Credentials for whichever third-party services your workflows will use: added inside n8n, not
  as deploy variables.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `N8N_ENCRYPTION_KEY` | generated | Generated 32-character key that n8n uses to encrypt stored credentials. You do not set this, and it must stay stable across deploys. |
| `DB_POSTGRESDB_CONNECTION` | injected | The managed database's connection string, supplied by the platform. |

Set by the template, not by you: `N8N_USER_FOLDER=/data` (data on the volume) and
`DB_TYPE=postgresdb`.

## After deploy

1. Open the service URL. n8n shows its owner-setup screen on first visit.
2. Create the owner account. This is the admin login for the instance: there is no default
   password to change.
3. Build a workflow, or import one from n8n's template library.
4. Workflow data lives in the managed PostgreSQL database; files under `/data` are on the volume.
   Both survive restarts and redeploys.

## Licensing

n8n is **fair-code**, not OSS: it is distributed under the Sustainable Use License, and files
marked `.ee` are under a separate enterprise license. This template references the official image
and does not rebuild or rebrand it, which is the condition this registry holds itself to for
fair-code upstreams. Read the upstream license before using it commercially.

## Links

- Documentation: <https://docs.n8n.io>
- Upstream: <https://github.com/n8n-io/n8n>
- Image: `docker.io/n8nio/n8n`, pinned to `2.10.2`
- License: Sustainable Use License (see <https://github.com/n8n-io/n8n/blob/master/LICENSE.md>).
