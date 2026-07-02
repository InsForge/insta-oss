# insta-oss — Capabilities & Roadmap Plan

> **For agentic workers:** execute phases top-to-bottom with superpowers:executing-plans; each phase is independently shippable. Steps use `- [ ]`.

**Goal:** the open-source, self-hostable Instacloud runtime — same API surface as insta-platform, on local Docker, single-tenant, no billing — so the stock `insta` CLI / MCP / skills work unchanged.

**Architecture:** `instad` (Fastify daemon on 127.0.0.1) → Engine (project/branch lifecycle, provider-agnostic) → local adapters (`LocalPostgres` · `DockerCompute` · `LocalMinio`) + govern (HITL gates) + events, state in `~/.insta-oss/state.json`.

---

## ✅ v1 — DONE (verified 2026-07-02)

What it can do today, all proven by tests (12/12) + driving it with the **stock cloud CLI unchanged**:

- [x] **Daemon** serving the platform's endpoint shapes (`/me`, `/orgs`, `/orgs/:id/projects`, `/projects/:id` + branches/deploy/secrets/policy/approvals/events); builtin `local` org/user; no OAuth (localhost trust); clean 501s for cloud-only surfaces (usage/billing/tokens/metrics/logs).
- [x] **Project create** → provisions `main`: Postgres container + MinIO bucket (+ compute on deploy).
- [x] **Branch = full clone**: new Postgres (pg_dump→restore) + bucket copy (mc mirror) + re-deploy of every app group — fully isolated (verified: clone writes never touch the source, db and bucket).
- [x] **Deploy (image mode)**: user's image as custom compute per group, wired with `DATABASE_URL` + S3 bundle; redeploy = replace.
- [x] **Secret seam**: `insta secrets` → `DATABASE_URL`, `AWS_ACCESS_KEY_ID/SECRET`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `BUCKET_NAME` (cloud-shaped keys).
- [x] **Governance**: gates `secrets.read | deploy | project.delete | branch.delete` → allow/deny/approve; 202 + approvalId; one-shot grants; `approve --always`; per-project policy.
- [x] **Events timeline**: resource + govern events; agent ingest (`POST /events`) with dedup_key — observe-hook compatible.
- [x] **Teardown with compensation** — no orphaned containers (db destroyed if storage provision fails).
- [x] **CLI parity table** in README, verified against every registered `insta` command.
- [x] Wired into the superrepo as `oss/` submodule (insta-cloud PR #7).

Shared MinIO note: one persistent `io-minio` container holds all branch buckets — by design, not a leak.

---

## Phase 2 — metrics & logs (docker-backed)

Replace the 501s with real local implementations, keeping the cloud response shapes.

- [ ] `GET /projects/:id/logs?component=compute[&group=]` → `docker logs --tail` of the branch's app container(s); shape `{ source, lines: [{ts, message, instance}] }` (match platform's LogsResult).
- [ ] `GET /projects/:id/metrics?component=compute` → `docker stats --no-stream` (cpu %, mem) as `{ source, series: [{name, points}] }`.
- [ ] `component=db` → same for the Postgres container.
- [ ] Contract tests with fake docker; one integration test asserting `insta logs compute` prints lines.

## Phase 3 — scale-to-zero + router (the density feature)

- [ ] **Router** in the daemon: `<branch>.<project>.lvh.me:<router-port>` → branch app container (replaces raw host-port juggling); registry in state.
- [ ] **Port allocator**: replace the naive `port + 1000` on branch redeploy with allocated host ports (or router-only exposure).
- [ ] **Reaper**: no requests through the router for N seconds → `docker stop` the branch's containers (app + pg); state marks branch `suspended`.
- [ ] **Wake-on-request**: router holds the request, `docker start` db-then-app, health-wait, forward. Target < 5s cold.
- [ ] Tests: idle→stopped, request→started, data intact after wake.

## Phase 4 — source-mode deploy

Blocked on / paired with the CLI gaining `insta deploy ./dir` (parity rule: no OSS-only commands).

- [ ] Daemon accepts an upload or local path; `Dockerfile` → `docker build`; else Nixpacks → image; then normal deploy.
- [ ] Test: deploy the examples/ app from source, HTTP 200.

## Phase 5 — MCP (shared with cloud)

One MCP server, thin client over the same endpoints (lives in the `mcp/` submodule, not here); insta-oss just needs to keep serving the surface. Local mode = stdio pointed at `http://127.0.0.1:8080`.

- [ ] Verify the mcp submodule's tools run against instad unchanged (same test style as the CLI parity sweep).

## Phase 6 — local dashboard (open) via shared insta-ui

- [ ] `insta-ui` package: project/branch/deploy/manifest/govern views + API-client hooks (backend-agnostic — same endpoints both sides).
- [ ] Single-tenant shell: no auth, points at instad. (Cloud dashboard = closed shell over the same insta-ui.)

## Hardening backlog (any time)

- [ ] Encrypt secrets at rest in state.json (platform uses AES-256-GCM + KEK; local can use a machine key).
- [ ] `insta-oss up/down/status` daemon lifecycle commands (detach + pidfile) instead of foreground-only.
- [ ] Concurrent-request safety on the JSON state (single write lock or move to SQLite).
- [ ] Publish `@insforge/insta-oss` to npm (`npx @insforge/insta-oss up`) when open-sourcing.
