# Migration guide validation — test record

> **Live record, opened 2026-09-09.** The Render and Railway guides merged as `e1bfc15`
> (insta-oss#98) and the runbook they delegate to merged as `9a4f2d7` (insta-skills#81). Those
> pages hand the reader a prompt and stay deliberately thin, so nearly every claim they make is
> really a claim about the runbook. This file records what was executed against it, so a later
> reader can tell a verified statement from a plausible one.

The matrix and its reasoning are in `insta-cloud/docs/superpowers/plans/2026-09-09-migration-guide-validation-plan.md`.
This is the execution log.

## Why a matrix, not more apps

Case 0 (below) established that the mechanical half of the guide can hold completely while the
migration is still broken: `connect-repo --public` needed no GitHub App, nixpacks built a
Dockerfile-less Django repo, the `DATABASE_URL` binding reached the app, nixpacks ran
`manage.py migrate` unprompted, gunicorn bound the declared port — and the app answered **HTTP 400
to every request**, because its `ALLOWED_HOSTS` came only from `RENDER_EXTERNAL_HOSTNAME`.

Ten more Django apps would have found the same single bug. So each case below is chosen to add at
least one cell no other case covers.

Two rules follow from that run and apply to every case:

1. **"Build succeeded" and "the app serves" are separate verdicts.** The health check is TCP on the
   port (`insta-platform/src/adapters/fly.ts`: `config.checks = { port: { type: 'tcp' } }`), so a
   service refusing every request is indistinguishable from a working one in `insta compute status`.
   Every case ends in a `curl`.
2. **Workers never create projects.** `insta project create` writes the link that
   `findProjectRoot` resolves by walking up, so once `~/.insta/project.json` exists every unlinked
   directory under `$HOME` shares it — two workers collide. Projects are created serially up front
   and each worker is pinned with `INSTA_PROJECT_ID` / `INSTA_ORG_ID`, which `readProject` honours
   ahead of any file.

## Environment

**staging**, agent mode (`insta --agent`), org `441f7efc-fbdd-43b2-bacc-df46892722f7`.

The plan originally specified prod, because staging did not have the agent-governance routes: a
credentialed `POST /agent/sessions` there answered Fastify's `Route POST:/agent/sessions not found`
while `GET /orgs` answered 200. That is no longer true — the same probe now returns
`400 body must have required property 'publicKey'`, so the route is deployed. With the plane the
same on both (`[insta-compute]` in the deploy logs either way), staging costs no production
resources and validates the same surface.

## Cases

| # | project | repo | covers | result |
|---|---|---|---|---|
| 0 | (deleted) | `render-examples/django` | baseline: nixpacks python, compute+pg, http | **done** — see above |
| 1 | `mv1-express` | `render-examples/express-hello-world` | nixpacks **node**; **compute only, zero bindings** | pending |
| 2 | `mv2-gogin` | `render-examples/go-gin-web-server` | nixpacks **go** (compiled); **no `render.yaml` and no Dockerfile** | pending |
| 3 | `mv3-laravel` | `render-examples/php-laravel-docker` | the **Dockerfile lane**; no `render.yaml` | pending |
| 4 | `mv4-celery` | `render-examples/celery` | **portless worker (`port === 0`)**; a **redis** binding; one repo, two compute services | pending |
| 5 | `mv5-strapi` | `render-examples/strapi-postgres` | a **volume** whose `mountPath` is not `/data`; the older `env: node` spelling | pending |
| 6 | `mv6-django-data` | `render-examples/django` | **a cutover with data in it** — steps 2 to 5 with something to lose | pending |

Every repo's shape was verified against the repo before it was listed, not assumed from its name.

Case 6 exists to stress the two most recent fixes, both of which came out of review rather than
testing: step 1 now stops the service after its verification curl, because `services add` gives a
compute service a default domain and the deploy otherwise leaves a **second writable system** on
the public internet before the restore; and step 4's verification now counts every table exactly,
enumerated from `pg_class`, after `n_live_tup` was shown to report **0 for a fully populated table**
once statistics have been reset. A verification that cannot fail is worthless, so case 6 is asked to
prove the diff catches a deliberate deletion.

## Results

Filled in as each case reports. A case is not "passed" because it deployed: the record for each is
translate / build / boot / serve / bindings / delta.

_(pending)_

## Not covered

Heroku, Railway and Fly as sources, since there is no account to migrate *from*. Object storage
contents. Zero-downtime cutover. The per-source host-coupling table in the runbook is read from
each platform's own official example rather than executed, and stays labelled that way.
