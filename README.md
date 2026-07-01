# insta-oss

**Instacloud-oss** — the open-source, self-hostable runtime behind [Instacloud](https://github.com/InsForge/insta-cloud).
Runs anywhere Docker runs. Same branchable, agent-native workflow as the managed cloud —
on local containers, single-tenant, no accounts, no billing.

**The stock `insta` CLI works unchanged**: this daemon serves the same API surface
(paths + response shapes) as the Instacloud platform, and the CLI's default API URL is
already `http://localhost:8080`. MCP gets the same property — one thin client, two targets.

| | Instacloud (cloud) | insta-oss (this repo) |
| --- | --- | --- |
| db / storage / compute | Neon / Tigris / Fly (microVM) | Postgres / MinIO* / Docker containers |
| branch (clone) | CoW | copy (`pg_dump` → restore) — isolated |
| compute on branch | re-deploy | re-deploy (same semantics) |
| governance (HITL) + events | ✅ | ✅ same gates, one-shot grants, `--always` |
| auth | OAuth | none — localhost trust |
| orgs / billing / usage / metrics | ✅ | 501 (cloud-only) |

*MinIO storage is on the roadmap; today an environment = your app container(s) + Postgres.

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
insta secrets --print        # the credential seam
insta manifest               # agent-legible env view
insta project delete         # gated → approval required (HITL)
insta approvals approve <id> # [--always]
insta events                 # audit timeline (resource + govern + agent ingest)
```

## Test

```bash
npm test        # 10 API-contract tests (no Docker) + 1 real-Docker isolation test
```

## Layout

```
src/main.ts            daemon entry (instad)
src/server.ts          the platform-compatible API surface
src/engine.ts          project/branch lifecycle (clone = copy + redeploy)
src/govern.ts          HITL gates · policies · one-shot approvals
src/adapters/          local providers: postgres (copy-branching) · docker compute
src/state.ts           single-tenant JSON state
```
