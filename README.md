# insta-oss

insta-oss is `instad`, a local daemon that reimplements the [InstaCloud](https://instacloud.com)
control plane on Docker — single-tenant, no accounts, no billing. Every project gets a Postgres
database, an S3 bucket, and your app containers. Every branch is a disposable, fully isolated
clone of all three.

The stock [`insta` CLI](https://github.com/InsForge/insta-cli), the insta-mcp server, and the
agent skills work against it unchanged; workflows built here run as-is on managed InstaCloud.

Two ideas set it apart from a plain local stack:

- **A branch is a whole environment, cloned.** `insta branch create` copies the database (with
  data), copies the bucket, and redeploys every app container — in seconds, each on its own URL.
  Break it, throw it away; the source is never touched. One task, one branch, many in parallel.
- **Governance at the credential boundary.** The daemon is the only thing holding credentials,
  and every sensitive action passes an allow / deny / approve gate before it touches a resource.
  An `approve` gate parks the action until a human runs `insta approvals approve` — an agent that
  ignores its instructions still cannot get past it. Every action lands in the `insta events`
  audit timeline.

## Quick start

Prerequisites: Docker (running) and Node ≥ 22. Nothing else — no cloud account, no API keys.

```bash
git clone https://github.com/InsForge/insta-oss.git && cd insta-oss
npm install
npm run build:ui        # optional: the web dashboard, served by the daemon itself
npm run dev             # instad on http://127.0.0.1:8080  (INSTA_OSS_PORT to change)
```

First run pulls `postgres:16-alpine`, `dxflrs/garage`, and `rclone/rclone` — give it a minute.
State lives in `~/.insta-oss/`.

In another terminal, install the CLI and point it at the daemon:

```bash
curl -fsSL agents.instacloud.com | sh          # CLI + agent skills (or: npm install -g insta)
export INSTA_API_URL=http://127.0.0.1:8080     # the CLI defaults to the cloud
```

No `insta login` — the daemon trusts localhost.

## A session

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

Your app just reads standard env vars (`DATABASE_URL`, `AWS_*`, `BUCKET_NAME`) — no
insta-specific code, same code runs on the cloud. `insta deploy ./dir` builds from source
instead of an image. `insta manifest` shows each branch's db / storage / compute;
`insta logs` and `insta metrics` tail containers and sample CPU/memory.

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

Cloud-only concepts — billing, usage metering, org management, machine scaling, custom
domains — return clean `501`s. The command-by-command CLI and MCP compatibility tables are in
[docs/compatibility.md](docs/compatibility.md).

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
