# insta-oss

**Instacloud-oss** — the open-source, self-hostable runtime behind [Instacloud](https://github.com/InsForge/insta-cloud).
Runs anywhere Docker runs. Same branchable, agent-native workflow as the managed cloud —
on local containers, single-tenant, no accounts, no billing.

**The stock `insta` CLI works unchanged**: this daemon serves the same API surface
(paths + response shapes) as the Instacloud platform, and the CLI's default API URL is
already `http://localhost:8080`. MCP gets the same property — one thin client, two targets.

| | Instacloud (cloud) | insta-oss (this repo) |
| --- | --- | --- |
| db / storage / compute | Neon / Tigris / Fly (microVM) | Postgres / MinIO / Docker containers |
| branch (clone) | CoW | copy (`pg_dump` → restore) — isolated |
| compute on branch | re-deploy | re-deploy (same semantics) |
| governance (HITL) + events | ✅ | ✅ same gates, one-shot grants, `--always` |
| auth | OAuth | none — localhost trust |
| orgs / billing / usage / metrics | ✅ | 501 (cloud-only) |

## Run

```bash
npm install
npx tsx src/main.ts          # daemon on 127.0.0.1:8080 (INSTA_OSS_PORT to change)
```

Then use the normal CLI (no login needed):

```bash
insta project create demo    # provisions main (Postgres container)
insta branch create feat     # clone: copies data, redeploys apps — isolated
insta deploy --image you/app:latest --port 8080
insta secrets --print        # the seam: DATABASE_URL + AWS_* S3 bundle
insta manifest               # agent-legible env view
insta project delete         # gated → approval required (HITL)
insta approvals approve <id> # [--always]
insta events                 # audit timeline (resource + govern + agent ingest)
```

## Test

```bash
npm test        # 10 API-contract tests (no Docker) + 2 real-Docker isolation tests (db + bucket)
```

## Layout

```
src/main.ts            daemon entry (instad)
src/server.ts          the platform-compatible API surface
src/engine.ts          project/branch lifecycle (clone = copy + redeploy)
src/govern.ts          HITL gates · policies · one-shot approvals
src/adapters/          local providers: postgres (copy-branching) · docker compute · shared MinIO (bucket-per-branch)
src/state.ts           single-tenant JSON state
```

## CLI command parity (stock `insta` CLI vs this daemon)

The OSS follows the canonical CLI/cloud command surface exactly — no OSS-only commands.
Verified by running every registered CLI command against the daemon:

| Command | insta-oss behavior |
| --- | --- |
| `status` | ✅ (`user: local`) |
| `org list` | ✅ builtin single org (`local`) |
| `project create/link/list/delete` | ✅ (delete is govern-gated) |
| `branch create/switch/delete/list` | ✅ (create = clone: db copy + bucket copy + app redeploy) |
| `deploy` | ✅ (govern-gated) |
| `secrets` / `secrets list` | ✅ full bundle: `DATABASE_URL` + `AWS_*` + `BUCKET_NAME` (gated) |
| `manifest` | ✅ per-branch postgres / storage / compute |
| `policy` / `policy set` | ✅ |
| `approvals list/approve/deny` (`--always`) | ✅ one-shot grants, same 202 flow |
| `events` | ✅ resource + govern timeline, agent ingest with dedup |
| `login/logout` | cloud-only (no OAuth locally — localhost trust) |
| `metrics` / `logs` | 501 with clear message (docker stats/logs planned) |
| `usage` / `billing` | 501 — cloud-only by design (no metering in OSS) |
| `org create` / `tokens` | 501 — single-tenant |

**Branching vs merging:** `branch` = a disposable isolated environment (clone). There is no
`branch merge` in the cloud or here — merge happens at the **git level**: merge your code,
run migrations against main, redeploy, delete the branch env. Branch data never merges back.
