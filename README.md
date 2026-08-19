# insta-oss

The [InstaCloud](https://instacloud.com) control plane, reimplemented as a single local daemon
on your own Docker — single-tenant, no accounts, no billing.

```
project = a Postgres database + an S3 bucket + your app containers
branch  = a disposable, fully isolated clone of all three
```

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[Quick start](#quick-start) · [insta CLI](https://github.com/InsForge/insta-cli) ·
[Hosted InstaCloud](https://instacloud.com) · [Discord](https://discord.com/invite/MPxwj5xVvW)

## Overview

insta-oss is not an emulator: it serves the same API as managed InstaCloud, backed by real
local resources — a real Postgres per branch, a real S3 bucket, your real app containers. The
stock `insta` CLI, the insta-mcp server, and the agent skills work against it unchanged;
workflows built here run as-is on the cloud.

Everything it creates is plain Docker. Stop the daemon and your Postgres is still Postgres,
your bucket still speaks S3 — you lose the branching and the gates, not your data.

## What makes it different

**A branch is a whole environment, cloned.** `insta branch create` copies the database (with
data), copies the bucket, and redeploys every app container — in seconds, each branch on its
own URL. Break it, throw it away; the source is never touched. One task, one branch, many in
parallel.

**Governance at the credential boundary.** The daemon is the only thing holding credentials,
and every sensitive action passes an allow / deny / approve gate before it touches a resource.
Agents propose, humans approve: a gated action parks until someone runs
`insta approvals approve` — an agent that ignores its instructions still cannot get past it.
Every action lands in the `insta events` audit timeline.

## Features

- **Deploys** — `insta deploy --image you/app` or `insta deploy ./dir` (built locally);
  redeploy = replace, credentials injected.
- **Secrets** — one seam: standard `DATABASE_URL` / `AWS_*` env vars, scoped
  project → branch → service; apps need no insta-specific code.
- **Managed databases** — private Redis / MySQL / MongoDB containers per branch.
- **Observability** — `insta logs` / `insta metrics` per container, plus live Postgres
  insight (connections, cache-hit, running queries, top statements).
- **Audit timeline** — every resource and governance action in `insta events`.
- **Dashboard** — a web UI served by the daemon itself, approvals inbox included.
- **Agent-native** — `project create` installs the agent skills into your repo; insta-mcp
  works against the daemon.

## Quick start

Prerequisites: Docker (running) and Node ≥ 22. Nothing else — no cloud account, no API keys.

```bash
git clone https://github.com/InsForge/insta-oss.git && cd insta-oss
npm install
npm run build:ui        # optional: the web dashboard, served by the daemon itself
npm run dev             # the daemon, on http://127.0.0.1:8080  (INSTA_OSS_PORT to change)
```

First run pulls `postgres:16-alpine`, `dxflrs/garage`, and `rclone/rclone` — give it a minute.
State lives in `~/.insta-oss/`.

In another terminal, install the CLI and point it at the daemon:

```bash
curl -fsSL agents.instacloud.com | sh          # CLI + agent skills (or: npm install -g insta)
export INSTA_API_URL=http://127.0.0.1:8080     # the CLI defaults to the cloud
```

No `insta login` — the daemon trusts localhost. (Don't want to run it yourself?
[Hosted InstaCloud](https://instacloud.com) is the same API with none of the ops.)

## What it looks like

```bash
$ cd ~/my-app                       # the CLI links the project to your cwd
$ insta project create demo
created project 4496c3e1-… (demo)
  resources: postgres, storage, compute

$ insta secrets --print             # the only way credentials leave the daemon
DATABASE_URL="postgres://postgres:insta@io-demo-main-pg:5432/app"
AWS_ACCESS_KEY_ID="GK…"  AWS_SECRET_ACCESS_KEY="…"  AWS_ENDPOINT_URL_S3="http://io-garage:3900"
BUCKET_NAME="io-demo-main"

$ insta deploy --image nginx:alpine --port 80
deployed nginx:alpine -> http://localhost:80 (branch main, group default)

$ insta branch create feat          # copies the db + bucket, redeploys the app
created branch feat                 # feat's app: http://localhost:1080 — host port +1000

$ insta policy set deploy approve   # gate deploys behind a human
$ insta deploy --image nginx:alpine --port 80
approval required for deploy — run: insta approvals approve 7c3c9b68-…

$ insta branch delete feat          # done with the task: throw the clone away
```

`insta manifest` shows each branch's db / storage / compute and their URLs.

## How it works

Every request flows CLI/MCP/dashboard → HTTP server (routes + govern gate) → engine → an
adapter → Docker:

- **engine** (`src/engine.ts`) — project/branch lifecycle: provision, clone
  (`pg_dump` → restore, `rclone sync`, app redeploys), teardown with compensation on failure.
- **govern** (`src/govern.ts`) — the policy engine: 12 gated actions, allow/deny/approve per
  project, one-shot grants, HTTP 202 approval flow.
- **adapters** (`src/adapters/`) — swappable providers behind small contracts: `LocalPostgres`
  (a container per branch), `LocalGarage` (one shared S3 server; a bucket + bucket-scoped key
  per branch), `DockerCompute` (your image per compute group), `LocalManagedDb` (private
  Redis/MySQL/MongoDB containers per branch). `RailwayCompute`
  (`INSTA_OSS_COMPUTE=railway`) runs compute on Railway instead — proof the seam holds.
- **state** (`src/state.ts`) — a single JSON file, `~/.insta-oss/state.json`.

Command-by-command CLI and MCP compatibility tables: [docs/compatibility.md](docs/compatibility.md).

## Dashboard

The daemon serves a web UI at its own URL — one process, same origin, no login. Services,
environments, logs, secrets, database insight, operations, usage, an approvals inbox, and the
governance policy matrix; gated actions from the UI go through the same 202 → approve flow as
the CLI.

![The Services page, showing a live project](docs/img/dashboard-services.png)

`npm run build:ui` once, then open http://127.0.0.1:8080. UI development: `cd ui && npm run dev`
(Vite on :5173, proxying API calls to the daemon).

## Using it with agents

`insta project create` (or `link`) installs the insta agent skills into your project
(`.claude/skills/` for Claude Code, `.agents/skills/` for Codex — gitignored), so a coding
agent opened in the repo already knows the workflow: one task → one branch → deploy → verify →
delete. You keep the approval power (`insta policy set <action> approve`) and the audit trail
(`insta events`). The insta-mcp server is a thin client over the same endpoints — point it at
the daemon with `PLATFORM_API_URL=http://127.0.0.1:8080`.

## Tests

```bash
npm test    # API-contract tests (fake adapters, no Docker) + real-Docker isolation tests
```

The isolation tests prove clone independence for real: writes to a branch's database and
bucket never reach the source.

## Cleanup

```bash
insta project delete                                   # per project (approval-gated)
docker ps -aq --filter name=io- | xargs docker rm -f   # every insta-oss container
docker volume rm io-garage-meta io-garage-data         # the shared storage server's data
rm -rf ~/.insta-oss                                    # daemon state
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the code map and the rules every change follows.
Provider adapters are the best entry point: implement one interface from `src/types.ts` as a
new file in `src/adapters/`, wire it in `src/main.ts` — nothing else changes.

## Community

- [Discord](https://discord.com/invite/MPxwj5xVvW) — questions and support
- [X / Twitter](https://x.com/InsForge) — release updates
- [info@insforge.dev](mailto:info@insforge.dev)

## License

Apache-2.0 — see [LICENSE](LICENSE).
