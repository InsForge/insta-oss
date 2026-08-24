# n8n

Visual workflow automation with 400+ integrations.

> **Draft, not published.** The image deploys and n8n serves, but two things keep it out of the
> catalog, both measured on prod on 2026-08-24 against `n8nio/n8n:2.36.5`.
>
> 1. **The managed database cannot be wired from a manifest.** n8n reads its database as five
>    separate variables (`DB_POSTGRESDB_HOST`, `PORT`, `DATABASE`, `USER`, `PASSWORD`) and reads no
>    connection-string variable at all: grepping the shipped image for one returns nothing but a
>    docs link. A managed postgres mints exactly one credential, `DATABASE_URL`, and
>    `env.platform` can only rename a minted credential, never split it. So the `db` service below
>    provisions and binds correctly, and n8n still cannot reach it. The fix belongs in the
>    platform, which already splits `redis`, `mysql` and `mongodb` into host/user/password keys and
>    leaves postgres as the only type that is URL-only. Wiring the parts by hand proved the rest
>    works: n8n created its 132 tables and ran 246 migrations against the managed instance.
> 2. **The first deploy does not fit the health-check budget.** A first deploy gets 60s to answer
>    on its port. Pulling this image took 51s and n8n then needed 17s to bind, so the deploy failed
>    twice and the machine was destroyed both times. A redeploy over a live machine gets a larger
>    budget and succeeds, which is not a path a first-time user has.
>
> Neither is fixable from this directory, and neither is a reason to wrap the image: n8n is
> fair-code, and this registry references the official image rather than rebuilding it.

## Overview

[n8n](https://github.com/n8n-io/n8n) is a workflow automation tool: you build flows on a canvas,
connecting apps and APIs, and drop into code only where you need it. Upstream describes it as
fair-code workflow automation with native AI capabilities and 400+ integrations.

This template deploys the official upstream image unchanged, alongside a managed PostgreSQL
database for n8n's own storage, and points n8n's user folder at a persistent volume.

## What you get by hosting it

- An HTTPS URL for the n8n editor, with no port forwarding or tunnel to manage.
- A managed PostgreSQL database, provisioned and health-gated before n8n deploys.
- A 1 GiB volume mounted at `/data`, with `N8N_USER_FOLDER` pointed at it, so the settings file
  and any community nodes you install survive a redeploy.
- The encryption key generated for you and stored as a managed secret. n8n uses it to encrypt
  stored credentials, so it must not change between deploys.
- Your workflows and credentials on infrastructure you control, rather than a hosted tier.

## What you need before deploying

- Nothing at deploy time: the template declares no required variables. n8n runs its own
  owner-setup wizard on first visit, where you create the admin account.
- Credentials for whichever third-party services your workflows will use: added inside n8n, not
  as deploy variables.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `N8N_ENCRYPTION_KEY` | generated | 32-character key n8n uses to encrypt stored credentials. You do not set it, and it must stay stable across deploys. |
| `DATABASE_URL` | injected | The managed database's connection string, bound from the `db` service. n8n does not read it: see the draft note. |

Set by the template, not by you: `N8N_USER_FOLDER=/data` (user folder on the volume),
`DB_TYPE=postgresdb`, `N8N_PORT=5678`, `N8N_LISTEN_ADDRESS=0.0.0.0`, `N8N_PROXY_HOPS=1`, and
`N8N_WEBHOOK_URL` / `N8N_EDITOR_BASE_URL` resolved to the service's own HTTPS URL so webhook and
editor links come out right.

The compute size is pinned to `2vcpu-2gb`: n8n sits at roughly 557 MB resident while idle, so the
512 MB and 1 GB sizes leave no room for a workflow run.

## After deploy

1. Open the service URL. n8n shows its owner-setup screen on first visit.
2. Create the owner account. This is the admin login for the instance: there is no default
   password to change.
3. Build a workflow, or import one from n8n's template library.
4. Workflow data lives in the database; the settings file and community nodes live under `/data`
   on the volume. Both survive restarts and redeploys.

## Licensing

n8n is **fair-code**, not OSS: it is distributed under the Sustainable Use License, and files
marked `.ee` are under a separate enterprise license. This template references the official image
and does not rebuild or rebrand it, which is the condition this registry holds itself to for
fair-code upstreams. Read the upstream license before using it commercially.

## Links

- Documentation: <https://docs.n8n.io>
- Upstream: <https://github.com/n8n-io/n8n>
- Image: `docker.io/n8nio/n8n`, pinned to `2.36.5`
- License: Sustainable Use License (see <https://github.com/n8n-io/n8n/blob/master/LICENSE.md>).
