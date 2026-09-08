# 09 Integration order

Base: `feat/single-node-serverless` at `61df88b` (origin/main `ad0de09` + the spec). One integrator merges; implementers work in parallel worktrees branched from the scaffold commit (step 0) and rebase onto `feat/single-node-serverless` whenever an earlier package lands. Fake-adapter suites run everywhere on every push; Docker suites run only by the integrator, one file at a time, with `RUN_DOCKER_TESTS=1`.

## Step 0: scaffold (integrator, before implementers start)

One commit, no behaviour change, today's tests green.

1. `src/config.ts` exactly as `00-contract.md` section 3 (`Config`, `loadConfig`, `isDaemonHost`, `CONFIG_KEYS`); `test/config.test.ts` covering defaults, precedence (`INSTA_OSS_PORT` > `--port` > 8080), server mode without `INSTA_OSS_DOMAIN` throws, `bool()`/`int()` validation, `isDaemonHost` in both modes.
2. `src/types.ts` = contract section 4 verbatim (adapter interfaces final; `GATED_ACTIONS` gains `service.upgrade` and `src/govern.ts` DEFAULTS gains `'service.upgrade': 'allow'`).
3. Mechanical adaptation to the new adapter signatures with today's semantics: `src/adapters/postgres.ts` (`provision(t)` uses `t.container`, `t.network`, ignores `t.dataDir` when `''`, keeps the constant password; `fork(src, dst)` = provision `dst` then today's dump/restore, returns `{ url: src.url with the host swapped, method: 'basebackup', ms }`; `query/destroy/rename` by container); `src/adapters/manageddb.ts` (`provision(t)`, `destroy(container)`, `rename(container, to)`); `src/adapters/garage.ts` (`provision(ref, network, name)` -> bucket `io-<ref>-<name>`, `cloneInto/destroy/setAccess` by bucket handle; constructor `{ configPath, hostEndpoint }` replacing the two `process.env` reads); `src/adapters/compute.ts` (`volume: { hostPath }` mounted verbatim as `-v <hostPath>:/data` for the INTERIM named-volume name only; WP4 replaces it with `--mount type=bind`, decision 56; `stop(ref, group, opts)` ignores `opts`); `// ---- args WP2 ----`, `// ---- args WP3 ----`, `// ---- args WP4 ----` marker lines inside `deploy()`/`provision()` of the three adapters; `src/engine.ts` call sites: `pgContainerName(ref, 'db')`, `PgTarget` objects with `dataDir: ''`, `db.fork` in `createBranch`, `storage.provision(ref, network, 'store')`, handles read from `b.bucket`/`b.dbUrl` as today (no registrations yet), `volume: { hostPath: `io-${ref}-data-${vol.id}` }`; `EngineOptions { cfg? }` on the constructor; `buildServer(engine, cfg = loadConfig())`.
3b. Engine hook skeleton (contract 1.1): every `// filled by WPn` identity hook (`allocLanes`, `assertHostFree`, `layout`, `forkVolumes`, `sleepNewBranch`, `afterDeploy`, `withOp`, `serviceUrl`, `containerize`, `rowNetwork`, `rowRuntime`, `healthOverlay`, `limitsFor`, `volumeMount`, `localHostPort`, `hostAliasesFor`) in its owner's region returning today's value, and `deployLocked` already assembling the 7.2 argument object through them, so WP2/WP3/WP4 replace hook bodies from day one and never touch `deployLocked` again.
3c. `src/main.ts` boot skeleton with every region marker in final order (01 §1) and `src/state.ts` with the final export list of contract §5 (`initStatePath`, `statePath`, `stateRev`, `onSave`, `EVENTS_CAP`, `mutate(fn, opts)`, lock and `touchLater` stubs, `migrateState = (s) => s`) carrying today's bodies where behaviour exists; WP1 fills the rest.
3d. `src/server.ts`: `export const API_PREFIXES` (today's `isApiPath` list) with a `// WP1` and a `// WP5` marked line; the `/me` + `/tokens` 501 stubs moved into region A, limits + always-on into region C, the three `compute/domain` stubs into region B, byte-identical behaviour.
4. `test/fakes.ts` per contract section 6 (today's canned SQL answers keyed by container; recorders for `hostAliases`, `limits`, `graceSec`, `data.*` present but unused; `FakeRuntime`/`FakeUpstream` land with WP3); `test/server.test.ts` imports it and `app = buildServer(makeEngine())`; the 501 sweep array at line 218 split into `NOT_CLOUD_WP1`, `NOT_CLOUD_WP2`, `NOT_CLOUD_WP3`, `NOT_CLOUD_REST` concatenated; the only assertion edits: `db.provision:demo-main` -> `db.provision:io-demo-main-pg-db`, `db.clone:demo-main->demo-feat` -> `db.fork:io-demo-main-pg-db->io-demo-feat-pg-db`, `st.provision:demo-main` -> `st.provision:demo-main:store`, `db.provision:demo-feet` at line 1272 likewise, `deploy.volume` strings unchanged.
5. Region markers (contract 1.3) in `src/engine.ts`, `src/server.ts`, `src/types.ts`, `src/state.ts`, `src/main.ts`, `src/manageddb.ts`, `src/adapters/{compute,postgres,manageddb}.ts` (the `args` lines), `test/server.test.ts`, `test/fakes.ts`, `ui/src/api.ts`; `.github/workflows/ci.yml` ends with `# ---- WP4 ----` then `# ---- WP6 ----`.
6. `vitest.config.ts`: exclude `test/**/*.int.test.ts` unless `RUN_DOCKER_TESTS`; `.github/workflows/ci.yml`: `RUN_DOCKER_TESTS=1 INSTA_OSS_SCHEDULER=0` on the `npm test` step.
7. Verify: `npm run typecheck && npm run lint && npm test`; `RUN_DOCKER_TESTS=1 npx vitest run test/clone-isolation.int.test.ts` (the interim `fork` path), `test/storage.int.test.ts`, `test/restart.int.test.ts`; `npm run dev` prints today's three lines.

Then spawn the eight implementers from this commit. Each plan's "Done when" is the acceptance bar for its PR; the integrator additionally runs the checks below after each merge.

## Merge 1: WP1 identity/config

After merge verify: `npm test` (all fake suites incl. `server-auth`, `identity`, `state-lock`, `config`); the 401 sweep passes with today's route set; `npm run dev` output byte-identical; `INSTA_OSS_MODE=server INSTA_OSS_DOMAIN=x.test INSTA_OSS_DATA_DIR=$tmp npx tsx src/main.ts` boots, `/me` 401, sign-up + `/tokens` via curl, `insta login --api-key` against it; a second daemon on the same data dir exits with the lock message. Docker: `test/restart.int.test.ts` only (state.ts changed).

No rebase surprise: the scaffold's `main.ts` skeleton already carries every region in final order, so WP1 fills bodies and other packages' region lines stay where they are.

## Merge 2: WP5 templates/parity

After merge verify: `npm test` (`templates.test.ts`, the edited `server.test.ts` assertions: project create `resources: []`, services add postgres/storage, credentials, legacy state migration, db routes with `?group=`); the 401 sweep now includes the template routes and `GET /templates*` is public in server mode; `GET /templates` lists the bundled codes minus drafts; every hook WP5 calls exists as an identity in its owner's region (`grep -n 'filled by WP' src/engine.ts` lists `allocLanes`, `assertHostFree`, `layout`, `forkVolumes`, `sleepNewBranch`, `afterDeploy`, `withOp`, `serviceUrl`, `containerize`, `rowNetwork`, `rowRuntime`, `healthOverlay`, `limitsFor`, `volumeMount`, `localHostPort`). Docker: `test/clone-isolation.int.test.ts` (two-postgres variant), `test/storage.int.test.ts` (handles `io-<ref>-store`), `test/template-deploy.int.test.ts` (n8n on main; the health probe hits `apps[group].url` directly until WP2, so the test tolerates `http://localhost:<hostPort>`).

No rebase surprise: the hook skeleton and the `deployLocked` argument object come from the scaffold (step 3b), so WP5's rewrite of `provisionBranch`, `createBranch` and `services()` conflicts with nobody's hook bodies. Also verify: `DELETE /services/:sid` returns `{ teardown }` for every type; `GET /services?branch=feat` returns qualified ids and `insta db url --branch feat` prints feat's DSN against the daemon.

## Merge 3: WP4 branching/data dir

After merge verify: `npm test` (`fsclone`, `postgres-adapter`, `datadir-migrate`, `server.test.ts` region WP4); `npm run lint` with the `.cjs` file. Docker (in this order): `test/fork.int.test.ts` with `INSTA_OSS_FORK=auto` on APFS (reflink) then with `INSTA_OSS_FORK=basebackup`; `test/datadir-migrate.int.test.ts`; `test/clone-isolation.int.test.ts` (asserts `db.method`); `test/storage.int.test.ts`; `test/restart.int.test.ts`. Boot a daemon over a copy of a pre-scaffold `~/.insta-oss` and confirm the migration summary and that `insta secrets` still resolves. CI: the XFS loop step runs green on ubuntu-latest.

## Merge 4: WP3 scheduler

After merge verify: `npm test` (`scheduler`, `upstream`, `server.test.ts` region WP3, `restart-policy` additions); the 501 sweep lost exactly the limits and always-on rows; the ONLY existing assertion WP3 changed is lines 475-489 (`state: 'stopped'` after stop, decision 53); `ComputeAdapter.state` is gone from `src/types.ts`, the adapter and the fake; `GET /policy` lists `service.upgrade`. Docker: `test/sleep-wake.int.test.ts` (ticker on, `INSTA_OSS_RAM_FLOOR_PCT=0` outside the eviction case); then every other Docker suite with `INSTA_OSS_SCHEDULER=0` to prove on-demand wake/sleep work with the ticker off (the idle knobs alone would leave the pressure pass running on a low-RAM runner). Manual: local daemon with `INSTA_OSS_IDLE_COMPUTE_SEC=15 INSTA_OSS_SWEEP_SEC=2 INSTA_OSS_CREATE_GRACE_SEC=0`, deploy whoami, wait, `docker ps` shows exited (not paused), `insta compute start` wakes; `insta compute limits web --memory 512mb` lands in `HostConfig.Memory`.

## Merge 5: WP2 router

After merge verify: `npm test` (`router`, `router-table`, `internal`, `server.test.ts` region WP2); the 401 sweep covers the four domain routes; `GET /tls/ask` is not a Fastify route. Docker: `test/router.int.test.ts`; `test/template-deploy.int.test.ts` again (health probe now through the router hostname); `test/sleep-wake.int.test.ts` again (traffic door). Manual local: `insta deploy` prints `http://<group>-<ref>.localhost:8080`; `curl -H Host:` answers; `psql "$(insta db url)"` through the lane port; on Linux a container reaches `http://<own-host>:8080` through `host-gateway`. Rerun the WP3 manual sleep check: a curl to a sleeping service wakes it and answers within the hold.

## Merge 6: WP6 packaging

After merge verify: `npm test` (`install.test.ts`: `--print-env` carries every `CONFIG_KEYS` entry); `shellcheck -s sh install.sh`; `docker build`. Docker: `test/image.int.test.ts`, `test/compose.int.test.ts`. Real VM (integrator, once per release candidate): fresh Ubuntu 22.04 with a public IP and ufw enabled, `sh install.sh`, setup page over valid TLS, `insta login --api-key`, `insta template deploy hermes`, `psql` over public 5432 by SNI, an app container reaches its own `DATABASE_URL` and `https://s3.<domain>` from inside (the ufw rules and `--add-host` entries), `docker info -f '{{json .DefaultAddressPools}}'` shows the `10.100.0.0/14` pool, a loop creating 40 branches on one project succeeds (the 31-network default would fail at 32), `reboot` with the loop image renamed away leaves docker.service stopped rather than Postgres on an empty directory, re-run = upgrade, `--tls internal` variant produces `edge/ca.pem`.

## Merge 7: WP7 dashboard

After merge verify: `npm run build:ui`; `npm test` includes `ui/src/lib/*.test.ts`; against a local daemon the Services page shows Sleeping/Wake, the Deploy dialog deploys an image and a template, Templates lists the catalog, no server-only UI; against the compose stack from merge 6: `/setup` flow, token line works, sign-out, Domains section on a compute service; watch `insta events` for one idle window with a tab open: no `service.wake`.

## Merge 8: WP8 docs/e2e

After merge verify: `npm test` includes `docs-lint`; `cd docs && npx mint dev` sidebar shows the seven pages; `.github/workflows/e2e.yml` both jobs green on the PR; README session copy-pasted against a fresh local daemon prints the claimed shapes; COMPATIBILITY rows match contract section 9.

## Docker test sequence (integrator, final pass on the assembled branch)

Run alone, in this order, each with `RUN_DOCKER_TESTS=1 npx vitest run <file>` and a clean `docker ps -aq --filter name=io- | xargs -r docker rm -f` between files (also `docker volume rm io-garage-meta io-garage-data`; leave nothing under the tmp data dirs):

1. `test/restart.int.test.ts`
2. `test/storage.int.test.ts`
3. `test/clone-isolation.int.test.ts`
4. `test/fork.int.test.ts` (auto, then `INSTA_OSS_FORK=basebackup`)
5. `test/datadir-migrate.int.test.ts`
6. `test/sleep-wake.int.test.ts`
7. `test/router.int.test.ts`
8. `test/template-deploy.int.test.ts`
9. `test/image.int.test.ts`
10. `test/compose.int.test.ts`
11. `e2e/local-smoke.sh` on a Linux host (needs the host to resolve `*.localhost` or the `/etc/hosts` fallback)
12. `e2e/server-smoke.sh` on a throwaway VM

Every Docker file uses its own project name and sets `INSTA_OSS_SCHEDULER=0` unless it tests sleep (`test/sleep-wake.int.test.ts` runs the ticker with `INSTA_OSS_RAM_FLOOR_PCT=0` outside its eviction case; the e2e scripts keep the ticker and set `INSTA_OSS_RAM_FLOOR_PCT=0`); `INSTA_OSS_DATA_DIR` is a realpath'd tmp dir per file.

## Conflict rules at merge

- A conflict inside a region: take the region owner's side, re-apply the other side's lines inside their own region.
- A conflict at a 7.2 edit point: WP5's skeleton wins; the hook body goes into the owner's region.
- A conflict in `src/types.ts`: the contract text wins; a package that needs a new field updates `00-contract.md` first in its PR.
- A conflict in `test/server.test.ts` outside a region: the existing assertion wins unless its edit is listed in the merging package's plan.
- A new route: it must appear in contract section 9 with cloud evidence before the PR is merged; the 401 sweep must cover it (or the allowlist must name it with a reason).

## What the integrator hands back to Tony

- The URL shape as implemented (`<group>-<ref>`, `pg-<name>-<ref>`, `<type>-<name>-<ref>`) and the idle defaults (5 min, 10 min, 15 percent) for sign-off (spec action item 1).
- The list of documented divergences: always-on default false, volumes fork on self-host, MySQL external lane plaintext per-service port, scopes recorded not enforced, `logoUrl` as a data URI, template stats per daemon.
- Open items outside this repo: reserve `get.instacloud.com`; insta-e2e follow-up PR; insta-skills reference updates; the `/tokens`, `always-on`, `limits`, `compute/domain`, `template-deployments` shapes confirmed with the platform team (spec action item 5) against the citations in contract section 9.
