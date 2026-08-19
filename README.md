<div align="center">

  <h1>insta-oss</h1>

  <p>
    The self-hostable runtime for <b>branchable, agent-native environments</b>.<br />
    Every project gets a database, object storage, and your app containers —<br />
    every <b>branch is a disposable, fully isolated clone</b> of all three.
  </p>

  <p>
    <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache%202.0-orange.svg" alt="License"></a>
    <a href="https://github.com/InsForge/insta-oss/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/InsForge/insta-oss/ci.yml?branch=main&label=CI" alt="CI"></a>
    <a href="https://github.com/InsForge/insta-oss/graphs/contributors"><img src="https://img.shields.io/github/contributors/InsForge/insta-oss?color=green" alt="Contributors"></a>
    <a href="https://github.com/InsForge/insta-oss/pulls"><img src="https://img.shields.io/badge/PRs-welcome-blue.svg" alt="PRs Welcome"></a>
  </p>
  <p>
    <a href="https://x.com/InsForge"><img src="https://img.shields.io/badge/Follow%20on%20X-000000?logo=x&logoColor=white&style=for-the-badge" alt="Follow on X"></a>
    <a href="https://discord.com/invite/MPxwj5xVvW"><img src="https://img.shields.io/badge/Join%20our%20Discord-5865F2?logo=discord&logoColor=white&style=for-the-badge" alt="Join our Discord"></a>
  </p>

</div>

<p align="center">
  ⭐ <em>If branchable local environments are useful to you, a star helps other developers find this. </em>
</p>

## insta-oss

Runs anywhere Docker runs — single-tenant, no accounts, no billing, no external services.
Driven by the standard **`insta` CLI** (its default API URL is already `http://localhost:8080`,
so it works out of the box). Workflows built here run unchanged on managed Instacloud.

Two things make it more than a local backend:

- **Instant cloning** — `insta branch create` clones the whole stack (database data, object
  storage, and every app container) into a disposable, fully isolated environment in seconds.
  Break it, throw it away; the source is never touched. One branch per task, run in parallel.
- **Built-in observability** — `insta logs` / `insta metrics` tail your containers and sample
  live CPU/memory, and the dashboard's Database page surfaces live Postgres insight (connections,
  cache-hit, running queries, top statements) — the same signals the managed cloud shows.

### How it works

Coding agents (or you) drive the daemon through the `insta` CLI and its agent skills; every
sensitive action passes a human-in-the-loop policy gate before it touches a resource:

```mermaid
graph TB

    subgraph TOP[" "]
        AG["AI Coding Agents · insta CLI · Dashboard"]
    end

    subgraph MID[" "]
        D["instad — the local daemon<br/>govern gates · audit events · branch engine"]
    end

    AG --> D

    D --> PG[Postgres per branch]
    D --> ST[S3 bucket per branch]
    D --> CP[Your containers per branch]
    D --> OBS[Logs · Metrics · DB insight]

    classDef bar fill:#0b0f14,stroke:#30363d,stroke-width:1px,color:#ffffff
    classDef card fill:#161b22,stroke:#30363d,stroke-width:1px,color:#ffffff

    class AG,D bar
    class PG,ST,CP,OBS card

    style TOP fill:transparent,stroke:transparent
    style MID fill:transparent,stroke:transparent

    linkStyle default stroke:#30363d,stroke-width:1px
```

## What makes it different

Most local backends hand your app a database and a bucket. insta-oss is built around two ideas
the commodity stack doesn't have:

### 1. Governance at the credential boundary

The daemon is the **only** thing that holds credentials, and it's a circuit breaker in front of
them. Every sensitive action — reading secrets, deploying, deleting a project or branch, changing
a service — passes a per-project policy gate set to **allow / deny / approve** before it touches a
resource. An `approve` gate physically parks the action (HTTP `202`) until a human runs
`insta approvals approve <id>`; grants are one-shot, and every action lands in an append-only
`insta events` audit timeline. This is the same model whether the caller is you, the dashboard, or
an autonomous agent — so **an agent that ignores its instructions still cannot get past a gate you
set**. Credentials leave only through the secret seam (`insta secrets` → standard `DATABASE_URL` /
`AWS_*` env vars), and each branch gets its own bucket-scoped storage key, so a leaked branch
credential reaches nothing else. Governance, not the database, is the product.

### 2. A branch is a whole environment, cloned — not a git branch

`insta branch create <name>` doesn't fork code; it **clones the entire running stack** into a
disposable, fully isolated environment, in seconds:

- the **database is copied** (`pg_dump` → restore) — the clone carries the parent's real data;
- the **storage bucket is copied** (`rclone sync`) with its own scoped credentials;
- **every app container is redeployed** against the clone, each on its own URL.

Writes to a branch never touch its source (test-verified). That makes the unit of work
**one task → one branch → one throwaway environment**: point an agent at a branch, let it build,
deploy, and verify against real cloned data, then delete it — `main` is never its playground, and
many branches run in parallel with zero collision. Promotion is deliberate and git-shaped: branch
environments **never merge data**. `insta branch merge` is *structural only* (it materializes
missing services on the target); schema moves forward the same way it does everywhere — you merge
your code, run migration files against `main`, redeploy, and delete the branch env.

## What it can do (v1)

- **Projects with real resources** — `project create` provisions a Postgres container, an
  S3 bucket (shared Garage server) with its own bucket-scoped access key, and compute slots for your app images.
- **Branch = a disposable isolated environment** — `branch create` clones the whole stack:
  database copied (`pg_dump` → restore), bucket copied (`rclone sync`), every app group
  re-deployed against the clone. Writes to a branch never touch its source (test-verified).
- **Deploy your own compute** — `deploy --image you/app` runs your container per compute
  group, injected with that branch's `DATABASE_URL` + S3 credentials. Redeploy = replace.
- **Services** — `insta services list` shows the project's postgres / storage / compute;
  `services add compute <name>` registers extra compute groups (workers, APIs) that materialize
  on their first `deploy --group <name>`; `services remove compute <name>` tears one down.
- **Managed databases** — `services add redis|mysql|mongodb <name>` runs a private
  Valkey / MySQL / MongoDB container per branch, reachable only on the branch network (the local
  twin of the cloud's private `.internal` hosts). Credentials ride the secret seam on the cloud's
  naming contract — `REDIS_URL_<NAME>` etc., plus canonical unsuffixed aliases (`REDIS_URL`) for
  the oldest service of each type. A branch clone gets a **fresh empty instance with a fresh
  password** — managed-db data never clones, exactly like the cloud.
- **User secrets** — `insta secrets set NAME value` (project-wide, `--branch` for one branch, or
  `--service` to bind it to one branch service so only that compute group's deploys receive it);
  merged into the credential bundle and injected on every deploy; reserved platform names rejected;
  branch-scoped secrets clone with the branch. `insta secrets list`/`tree` show the whole
  project→branch→service binding picture (names only).
- **Branch merge (structural)** — `insta branch merge <source>` materializes on the target every
  compute group deployed on the source but missing there, against the target's own db/bucket.
  No data ever merges — migration files carry schema forward, same as the cloud.
- **Compute lifecycle** — `insta compute start|stop|suspend|status` per branch: persistent
  developer intent (docker start/stop/pause) + live runtime state.
- **Storage access mode** — `insta services set-access storage store public|private` flips the
  branch bucket between anonymous public-read (served on Garage's web endpoint, :3902) and private.
- **The secret seam** — `insta secrets` is the only way credentials leave the daemon:
  `DATABASE_URL`, `AWS_ACCESS_KEY_ID/SECRET`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`,
  `BUCKET_NAME` — standard Postgres/S3 env vars, so apps need no insta-specific code.
- **Governance (HITL)** — every sensitive action gates to allow/deny/approve:
  `secrets.read/write`, `storage.read/write/delete`, `deploy`, `project.delete`,
  `branch.delete`, and `service.add/remove/setAccess/rename` (12 actions, same split and
  defaults as the cloud). Approvals are one-shot (`approve --always` makes it permanent);
  per-project `policy set`.
- **Audit timeline** — every resource + govern action lands in `insta events`; agents ingest
  findings via `POST /projects/:id/events` with dedup (observe-hook compatible).
- **Agent-legible manifest** — `insta manifest` prints each branch's db / storage / compute.
- **Observability** — `insta logs db|compute` tails the branch's containers (`docker logs`,
  cloud LogsResult shape — db logs work locally where the cloud returns a provider note);
  `insta metrics` serves a point-in-time `docker stats` snapshot; `/operations` exposes the
  control-plane operation log; `/database/{metrics,activity,query-stats}` run the same SQL as
  the cloud against the branch database (pg_stat_statements preloaded on new databases).
  Billing/usage metering stays cloud-only by design.
- **Database management** — password rotation (re-mints `DATABASE_URL`), extra databases
  (create / list / delete, primary + system databases guarded), extension install/removal
  (the image's real `pg_available_extensions`; `pg_stat_statements` is platform-required), and
  the console's deep-insight surface (`/database/insight`: size breakdown, per-table stats,
  vacuum health, unused indexes) — all served straight off the branch's own container.
- **Branch rename + runtime health** — `PATCH /branches/:id` renames a branch metadata-only
  (provider resources keep their frozen ref, exactly like the cloud); `/runtime-health` reports
  every service's live state from one docker read in the cloud's vocabulary
  (healthy / standby / crashed / starting / none — standby is rest, not failure).
- **Local dashboard** — the daemon serves a web UI at its own URL (see below): per-branch
  service table (live container status + local endpoints), environments (the project's
  branches), a pending-approvals
  inbox with one-click grant/deny, and the governance policy matrix.

Full roadmap and what's deliberately not in v1: [`docs/superpowers/plans/2026-07-02-insta-oss-roadmap.md`](docs/superpowers/plans/2026-07-02-insta-oss-roadmap.md).

## Dashboard

The daemon serves a web dashboard **at its own URL** — one process is both the API and the UI,
same origin, no CORS, no login (localhost trust, like everything else here).

![the Service page, showing a live project](docs/img/dashboard-services.png)

### Start it

Full startup from zero is in [Getting started](#getting-started-from-zero); if the daemon is
already set up:

```bash
npm run build:ui               # one-time (and after pulling UI changes)
npm run dev                    # start the daemon as usual
open http://127.0.0.1:8080     # ← the dashboard (the CLI talks to the same URL)
```

If the daemon runs on another port (`INSTA_OSS_PORT=4800`), the dashboard is there instead
(`http://127.0.0.1:4800`). Without a UI build the daemon runs API-only and `/` tells you the
one command to add it.

### What's on it

| Page | What it shows / does |
| --- | --- |
| **Service** | The selected environment's stack: Postgres, storage, and each compute group — status dot from live `docker ps` (Online / Stopped / Not deployed), the **local endpoint** (`io-<ref>-pg:5432`, `localhost:<port>`), last-updated. `+ Add` registers a compute group; ✕ removes one. |
| **Environments** | Every environment (= a project branch, same as `insta branch`) with its `Prod` chip on the default; create one (full clone: db copy + bucket copy + app redeploys) or delete one. Click an environment to scope the whole UI to it — the picker in the top bar does the same. |
| **Approvals** | The HITL inbox: every action your policy gates waits here with **Grant once / Grant always / Deny**. The sidebar badge shows the pending count live. |
| **Settings** | The governance policy matrix (`allow / approve / deny` per action — enforced by the daemon for every caller: CLI, agent, or this dashboard) and the audit-event timeline. |
| **Logs / Usage** | Live from the docker-backed observability endpoints: Logs tails the environment's containers (`docker logs`, db included); Usage shows a point-in-time container CPU/mem snapshot (`docker stats`) — deliberately *not* billing, that's cloud-only. |

Anything gated that you trigger from the UI pops the same `202 → approve → retry` flow the CLI
uses — one governance model, three clients.

<details>
<summary><b>More screenshots</b> — governance policy matrix + audit timeline, environments</summary>

![Settings: per-action policy matrix and the audit-event timeline](docs/img/dashboard-settings.png)

![Environments: the default branch with its Prod chip; create/delete clones](docs/img/dashboard-branches.png)

</details>

UI development: `cd ui && npm run dev` (Vite on :5173, proxying API calls to the daemon;
set `VITE_INSTA_API` if instad isn't on :8080).

## Architecture

```mermaid
graph TD
  CLI["insta CLI · MCP · (dashboard)"] --> D["instad — local daemon<br/>127.0.0.1 · no OAuth · single-tenant"]
  D --> ENG["Engine — project/branch lifecycle"]
  D --> GOV["Govern — gates · approvals · policy"]
  D --> EV["Events — audit timeline"]
  ENG --> PG[("LocalPostgres<br/>one container per branch")]
  ENG --> ST[("LocalGarage<br/>shared server · bucket + scoped key per branch")]
  ENG --> CP["DockerCompute<br/>your image per group"]
```

## Getting started (from zero)

**Prerequisites:** Docker (running) and Node ≥ 22. Nothing else — no cloud account, no API keys.

### 1. Spawn the daemon (+ dashboard)

```bash
git clone git@github.com:InsForge/insta-oss.git && cd insta-oss
npm install
npm run build:ui                  # one-time: build the dashboard the daemon will serve
npx tsx src/main.ts               # instad on 127.0.0.1:8080  (INSTA_OSS_PORT=4800 to change)
```

Then open **http://127.0.0.1:8080** in a browser — that's the dashboard. The same URL is the
API the CLI talks to; one process serves both. (Skipping `build:ui` is fine — the daemon runs
API-only and `/` tells you how to add the UI later.)

First run pulls `postgres:16-alpine`, `dxflrs/garage`, `rclone/rclone` — give it a minute.
Keep this terminal open (daemon runs in the foreground for now).

### 2. Get the `insta` CLI

```bash
# one-liner — CLI + agent skills for every coding agent on the machine (recommended):
curl -fsSL agents.instacloud.com | sh
# CLI only (native binary, no Node; macOS/Linux/WSL; checksum-verified):
curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/install.sh | sh
# or, with Node:  npm install -g insta   · quick try:  npx insta@latest status
```

> The CLI is evolving fast (v0.0.x). If an installed `insta` misbehaves, update it first —
> re-run the installer (idempotent) or `npm update -g insta`.

No `insta login` needed — the daemon trusts localhost and has a builtin `local` user.
If the daemon isn't on the default port: `export INSTA_API_URL=http://127.0.0.1:4800`.

### 3. Spawn a project (db + storage + compute)

```bash
cd ~/my-app          # the CLI links the project to your cwd (./.insta/project.json)
insta project create demo
#   resources: postgres, storage, compute
insta services list            # postgres/db · storage/store (+ compute groups as you add them)
insta secrets --print          # DATABASE_URL + AWS_* S3 bundle for branch main
insta secrets set APP_MODE demo   # your own config — rides the same bundle, injected on deploy
```

Behind the scenes: a `io-demo-main-pg` Postgres container, a `io-demo-main` bucket on the
shared Garage server (with an access key scoped to exactly that bucket), and a Docker network per branch. `project create` also installs the related
agent skills into your project (`.agents/skills/`, gitignored) so coding agents know the workflow.

### 4. Spawn your app into it (custom compute)

```bash
insta deploy --image ghcr.io/you/app:latest --port 8080
# → http://localhost:8080 — container gets DATABASE_URL + the S3 creds injected
insta deploy --image ghcr.io/you/api:latest --port 3000 --group backend   # more compute groups
```

**`--port` = the port your app listens on inside the container** (it's also the host port for
direct deploys). Give the container a few seconds to boot before hitting the URL.
Your app just reads `process.env.DATABASE_URL` / the `AWS_*` vars — same code runs on the cloud.

### 5. Spawn a branch — a full isolated clone

```bash
insta branch create feat       # copies the db + bucket, redeploys your app groups
insta manifest                 # see both branches with their own db/storage/compute
insta branch switch feat && insta secrets   # .env now points at the clone
```

Branch apps keep the **same listen port** but map to **host port +1000** (e.g. main on
`localhost:8080` → feat on `localhost:9080`; `insta manifest` shows each URL).
Break anything in `feat` — `main` is untouched. Throw it away with `insta branch delete feat`.

### 6. Govern it (the HITL circuit breaker)

```bash
insta policy set deploy approve      # now deploys need a human
insta deploy --image you/app:v2 --port 8080
# → approval required — run: insta approvals approve <id>
insta approvals approve <id> --always   # approve AND stop asking
insta events                            # the full audit timeline
```

### Complete example session (verified)

The exact flow below is run against every release — each output shown is real:

```bash
$ insta status
api:     http://127.0.0.1:8080     user: local     project: (none linked)

$ insta project create demo
created project 4496c3e1-… (demo)
  resources: postgres, storage, compute

$ insta services list
postgres/db  [ready]  pg-db
storage/store  [ready]  st-store

$ insta secrets set APP_MODE demo && insta secrets --print
DATABASE_URL="postgres://postgres:insta@io-demo-main-pg:5432/app"
AWS_ACCESS_KEY_ID="GK…"  AWS_SECRET_ACCESS_KEY="…"  AWS_ENDPOINT_URL_S3="http://io-garage:3900"
BUCKET_NAME="io-demo-main"
APP_MODE="demo"

$ insta deploy --image nginx:alpine --port 80
deployed nginx:alpine -> http://localhost:80 (branch main, group default)
$ curl -s -o /dev/null -w '%{http_code}' http://localhost:80        # verify before trusting it
200

$ insta branch create feat        # clones db (with data) + bucket, redeploys the app
created branch feat
# feat's app: http://localhost:1080 (host port +1000, same listen port) — also serves 200
# feat's db has main's rows; writes to feat never touch main (test-verified)

$ insta project delete
approval required for project.delete — run: insta approvals approve 7c3c9b68-…
$ insta approvals approve 7c3c9b68-…
$ insta project delete
deleted project 4496c3e1-…       # zero containers left behind
```

### Use it with an AI agent

The runtime is agent-native out of the box — **the agent skills install themselves**:

- `insta project create` / `link` auto-installs the **`insta` skill** (the workflow playbook:
  branch-per-task, secrets seam, approvals) plus the Neon-Postgres / Tigris-S3 / Better-Auth
  skills into your project (`.claude/skills/` for Claude Code, `.agents/skills/` for Codex —
  gitignored). Any agent opened in the repo picks them up automatically and knows how to
  drive `insta` correctly.
- It also installs the **observe hook** (`./.insta/observe`) — a credential-audit hook that
  scans the agent's tool calls for secret leaks and reports findings to `insta events`.
- Installed already / different agent? Add manually: `npx skills add InsForge/insta-skills -s insta`

Then open your coding agent in the project and just say what to build. The division of labor:

- **You** run the daemon once and hold the approval power (`insta policy set … approve` puts any
  action behind your explicit sign-off; `insta events` is your audit trail of everything).
- **The agent** works branch-per-task: it creates its own disposable environment (data included),
  deploys there, verifies the URL, and throws it away — `main` is never its playground.
- **The platform enforces the boundary** — a gated action physically waits for
  `insta approvals approve <id>`; an agent that ignores its instructions still can't get past it.

(MCP server over the same endpoints: coming.)

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Docker is required and must be running` | start Docker Desktop / dockerd |
| port 8080 in use (e.g. platform dev server) | `INSTA_OSS_PORT=4800 npx tsx src/main.ts` + `export INSTA_API_URL=http://127.0.0.1:4800` |
| first commands slow | one-time image pulls (postgres/garage/rclone) |
| where's my state? | `~/.insta-oss/state.json` (override with `INSTA_OSS_STATE`) |
| `io-garage` container never goes away | by design — it's the shared storage server holding every branch's buckets |

### Uninstall / clean slate

```bash
insta project delete            # per project (approval-gated)
docker rm -f io-garage && docker volume rm io-garage-meta io-garage-data   # shared storage server (deletes all buckets)
docker ps -aq --filter name=io- | xargs docker rm -f   # any strays
rm -rf ~/.insta-oss             # daemon state
```

## Test

```bash
npm test        # API-contract tests (fake adapters, no Docker) + real-Docker isolation tests (db + bucket)
```

## Code structure

```
insta-oss/
├── src/
│   ├── main.ts                 entry point — starts instad on 127.0.0.1 (checks Docker first)
│   ├── server.ts               HTTP layer (Fastify): the standard API surface + govern gating
│   │                           of sensitive routes (202 approval flow); cloud-only routes → 501
│   ├── engine.ts               core orchestration: project/branch lifecycle, deploy,
│   │                           clone = db copy + bucket copy + app redeploy, teardown
│   │                           with compensation, audit-event emission
│   ├── govern.ts               HITL policy engine: allow/deny/approve per action,
│   │                           one-shot grants, `--always` → permanent allow
│   ├── state.ts                single-tenant persistence (~/.insta-oss/state.json):
│   │                           projects · branches · policies · approvals · events
│   ├── types.ts                the model + adapter contracts (Database/Compute/Storage/ManagedDb)
│   ├── manageddb.ts            managed-db catalog (images/ports/env/bundles) + the seam's
│   │                           suffix naming contract — mirrors the platform's tables
│   ├── observe.ts              observability shapes + parsers (docker logs/stats, DB SQL)
│   ├── docker.ts               one helper: spawn the docker CLI, capture stdout, stdin pipe
│   └── adapters/               swappable providers behind the contracts in types.ts
│       ├── postgres.ts         LocalPostgres — container per branch; clone = pg_dump→restore
│       ├── compute.ts          DockerCompute — your image per group; listen port fixed,
│       │                       host port mapped (branch clones shift host side only)
│       ├── garage.ts           LocalGarage — one shared server, bucket per branch;
│       │                       clone = rclone sync; a bucket-SCOPED access key per branch
│       └── manageddb.ts        LocalManagedDb — redis/mysql/mongodb, one private container
│                               per branch; a clone = fresh empty instance (no data clone)
├── test/
│   ├── server.test.ts          API contract tests (fake adapters, no Docker, ~100ms)
│   ├── clone-isolation.int.test.ts   real Docker: db clone is copied AND isolated
│   └── storage.int.test.ts     real Docker: bucket clone is copied AND isolated
├── docs/superpowers/plans/     capabilities + phased roadmap
└── .github/workflows/ci.yml    typecheck + lint + full test suite on every push/PR
```

**How a request flows:** CLI/MCP → `server.ts` (route + govern gate) → `engine.ts`
(orchestration + state + events) → an adapter (`adapters/*`) → `docker.ts` → Docker.
The engine never talks to Docker directly for resources — only through the adapter contracts.

**Where to extend:**

- **Different database/storage/compute backend** → implement the matching interface in
  `types.ts` as a new file in `src/adapters/`, wire it in `main.ts`. Nothing else changes —
  the engine, server, tests, and CLI are provider-agnostic.
- **New endpoint** → don't. The surface mirrors the standard `insta` CLI (see parity table);
  additions belong in the shared CLI/platform contract first.
- **Behavior change** → contract test in `server.test.ts` (fast, fake adapters) and, if it
  touches containers or clone isolation, an integration test alongside the existing two.

## CLI command support

insta-oss implements the standard `insta` command surface — no custom commands.
Verified by running every registered CLI command against the daemon:

| Command | insta-oss behavior |
| --- | --- |
| `status` | ✅ (`user: local`) |
| `org list` | ✅ builtin single org (`local`) |
| `project create/link/list/delete` | ✅ (delete is govern-gated) |
| `branch create/switch/delete/list` | ✅ (create = clone: db copy + bucket copy + app redeploy) |
| `branch merge <source>` | ✅ structural + additive: missing compute groups materialize on the target against its OWN db/bucket — data never merges (gated `service.add`) |
| `deploy` | ✅ (govern-gated) |
| `secrets` / `secrets list` / `secrets tree` | ✅ full bundle (gated) + the names-only project→branch→service binding tree |
| `secrets set/unset NAME [--branch] [--service]` | ✅ project-wide, branch override, or service-bound (injected only into that group's deploys); reserved names rejected (gated `secrets.write`) |
| `services list/add/remove` | ✅ (gated); `add postgres\|storage` is idempotent — one of each per project, auto-provisioned, so the same onboarding script runs on both targets; `add redis\|mysql\|mongodb <name>` runs a private managed-db container per branch (fresh empty instance per branch clone, cloud parity) |
| `services secrets` / `set-access storage` | ✅ per-service secret names; bucket public-read ↔ private (gated `service.setAccess`) |
| `compute start/stop/suspend/status` | ✅ persistent intent (docker start/stop/pause) + live runtime state |
| `manifest` | ✅ per-branch postgres / storage / compute |
| `policy` / `policy set` | ✅ |
| `approvals list/approve/deny` (`--always`) | ✅ one-shot grants, same 202 flow |
| `events` | ✅ resource + govern timeline, agent ingest with dedup |
| `metrics` / `logs` | ✅ docker-backed (`docker stats` snapshot / `docker logs` tail — db logs included), cloud response shapes; `logs --deploy` (deploy-event feed) → 501, use `insta events` |
| `login/logout` | not needed — localhost trust, no accounts |
| `services scale/upgrade` | 501 — machine scaling / instance specs are cloud pricing concepts |
| `compute limits/always-on` | 501 — tier caps / the scale-to-zero lever are cloud pricing concepts; local containers already stay up |
| `storage list/get/delete` | ✅ object listing (prefix + cursor paging), presigned GET download, single delete — served from Garage's host port (:3900), gated `storage.read`/`storage.delete`; presigned-POST upload + bulk delete serve the console's file browser |
| `regions` | ✅ the single `local` region (this machine) |
| `usage` / `billing` | 501 — billing metering is cloud-only by design; local visibility = `manifest` + docker-backed `metrics`/`logs` |
| `org create` / `tokens` | 501 — single-tenant |

**Branching vs merging:** `branch` = a disposable isolated environment (clone).
`insta branch merge` is **structural only** — it materializes missing services on the target;
**data never merges back**. Schema moves at the **git level**: merge your code, run migration
files against main, redeploy, delete the branch env.

## Contributing

If you're interested in contributing, check the guide in [CONTRIBUTING.md](CONTRIBUTING.md).
We truly appreciate pull requests — all types of help are welcome, from a typo fix to a new
provider adapter (see **Where to extend** above).

## Documentation & Support

- **Roadmap** — [`docs/superpowers/plans/2026-07-02-insta-oss-roadmap.md`](docs/superpowers/plans/2026-07-02-insta-oss-roadmap.md)
- **[Discord](https://discord.com/invite/MPxwj5xVvW)** — join the community; we're responsive there
- **[X / Twitter](https://x.com/InsForge)** — follow for updates
- **Email** — [info@insforge.dev](mailto:info@insforge.dev)

## License

This project is licensed under the Apache License 2.0 — see the [LICENSE](LICENSE) file for details.

<p align="center">⭐ <b>Star us on GitHub</b> to get notified about new releases!</p>
