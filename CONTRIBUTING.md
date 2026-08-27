# Contributing to insta-oss

## Dev setup

Prereqs: Docker (running) + Node ≥ 22 (`.nvmrc`).

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm test              # contract tests (no Docker) + integration (needs Docker; pulls postgres/garage/rclone once)
npx tsx src/main.ts   # run the daemon locally
```

## Branch model

- `main` is the release branch: changes land via PR.
- Day-to-day work happens on `devel` (or a feature branch) and merges into `main` by PR.

## Code map

```
src/
├── main.ts              entry point: checks Docker, picks adapters, binds 127.0.0.1
├── server.ts            HTTP layer (Fastify): routes + govern gating (202 flow); cloud-only → 501
├── engine.ts            orchestration: project/branch lifecycle, deploy, clone, teardown
│                        with compensation, audit events
├── govern.ts            HITL policy engine: allow/deny/approve per action, one-shot grants
├── state.ts             single-tenant persistence (~/.insta-oss/state.json)
├── types.ts             the model + adapter contracts (Database/Compute/Storage/ManagedDb)
├── manageddb.ts         managed-db catalog (images/ports/env) + the secret naming contract
├── observe.ts           observability shapes + parsers (docker logs/stats, DB SQL)
├── s3.ts                hand-rolled SigV4 S3 client (list, delete, presigned GET/POST)
├── docker.ts            the single seam to Docker: spawn the docker CLI
└── adapters/
    ├── postgres.ts      LocalPostgres: container per branch; clone = pg_dump → restore
    ├── garage.ts        LocalGarage: one shared server; bucket + scoped key per branch;
    │                    clone = rclone sync
    ├── compute.ts       DockerCompute: your image per group; host port mapped per branch
    ├── manageddb.ts     LocalManagedDb: redis/mysql/mongodb, one private container per
    │                    branch; a clone gets a fresh empty instance
    └── railway.ts       RailwayCompute: the same ComputeAdapter contract over Railway's API

test/
├── server.test.ts               API contract tests (fake adapters, no Docker, fast)
├── clone-isolation.int.test.ts  real Docker: db clone is copied AND isolated
├── storage.int.test.ts          real Docker: bucket clone is copied AND isolated
├── railway.test.ts              RailwayCompute GraphQL contract (fake fetch)
└── restart-policy.test.ts       long-lived containers get --restart unless-stopped
```

**How a request flows:** CLI/MCP/dashboard → `server.ts` (route + govern gate) → `engine.ts`
(orchestration + state + events) → an adapter (`src/adapters/*`) → `docker.ts` → Docker.
The engine never talks to Docker for resources except through the adapter contracts.

## Where to extend

- **Different database/storage/compute backend**: implement the matching interface from
  `types.ts` as a new file in `src/adapters/`, wire it in `main.ts`. Nothing else changes:
  the engine, server, tests, and CLI are provider-agnostic (`railway.ts` is the existence
  proof).
- **New endpoint**: don't. The surface mirrors the standard `insta` CLI
  (see [docs/reference/compatibility.md](docs/reference/compatibility.md)); additions belong in the shared
  CLI/platform contract first.

## Guidelines

- **Keep CLI parity**: the daemon implements the standard `insta` command surface. Don't add
  daemon-only commands or endpoints; response shapes must keep the stock CLI working unchanged.
- **Every behavior change needs a test**: contract tests (fake adapters, fast) for API shapes,
  integration tests (real Docker) for anything touching containers or clone isolation.
- **Never orphan resources**: provisioning failures must compensate (destroy what was created).
- Match the existing style: small focused modules, comments only for non-obvious constraints.

## Reporting issues

Include: OS, Docker + Node versions, the daemon log, and the failing `insta` command.

## Docs and plans

- `docs/` is the Mintlify source for https://docs.instacloud.com. Navigation lives in `docs/docs.json`; a page missing from it still builds (reachable by URL, searchable) but does not appear in the sidebar, so list every page you add. Preview with `cd docs && npx mint dev`.
- Internal planning notes live in `plans/`, not under `docs/`.
