Makes insta-oss a single-node serverless runtime with the cloud's experience, per the spec committed in `plans/2026-09-08-single-node-serverless-spec.md`. Draft: the honest gap list is at the bottom and wants your call before this is merge-ready.

Two rules held throughout: the daemon adds **no endpoint the cloud lacks** (every new route exists in the platform's surface and was a 501 stub here), and local mode behaves exactly as it does today, so a laptop never regresses.

## What it does now

- **Identity.** First visit is a setup page that creates the admin. Cookie sessions for the dashboard, `insta_` tokens through the cloud's `/tokens` routes, a bearer and session guard on everything outside a small allowlist, and a write lock on the state file.
- **Real URLs.** A router owns hostnames: `<group>-<ref>.<domain>` for compute, `pg-<name>-<ref>` for databases. HTTP routes by Host, and a pg-wire lane terminates TLS and routes by SNI. Nothing is published beyond loopback in local mode. Custom domains use the cloud's `compute/domain` routes.
- **Sleep and wake, the cloud's rules.** One activity stamp per service, a sweep every 30 s, and the same four wake doors. Sleep is `docker stop` with a SIGTERM grace, never pause, so RAM is actually freed. Databases sleep too and wake on connect. Memory-pressure eviction sleeps the least recently active service when the box runs low, which is what makes "one VPS holds dozens of branches" mechanical rather than hopeful.
- **Branching by fork.** Postgres data and compute volumes are bind mounts on a reflink filesystem, so a branch is a checkpoint plus a reflink copy: about 2 s on this laptop regardless of size, with a streaming `pg_basebackup` fallback where reflinks are unavailable.
- **Templates and parity.** The bundled catalog is served through the cloud's template routes, so `insta template deploy` works against a self-hosted daemon. Projects now start empty like the cloud, and a project can hold several Postgres and storage services.
- **Packaging.** A daemon image, a compose stack and a one-line installer that refuses busy ports, provisions a reflink-capable data directory, and prints the setup URL. Re-running it is the upgrade.
- **Dashboard and docs.** Setup, login, tokens, a deploy dialog for images and templates, a templates gallery, service detail with domains, and sleep state with a wake action. Six self-hosting pages and a public e2e directory.

## Verification

| Check | Result |
|---|---|
| Fake-adapter suites | 474 tests, 27 files |
| Container suites | 7 green: restart, storage, clone-isolation, sleep-wake, template-deploy, image, compose |
| `e2e/local-smoke.sh` | green twice from a fresh data directory |
| typecheck, lint, `build:ui`, `shellcheck install.sh` | clean |

The smoke run is the one that matters. Boot, create a project, add Postgres and storage, deploy `traefik/whoami`, reach it through the router hostname, read the database with `psql` over the host-facing lane, branch and confirm the fork carried data and that writes do not leak back, watch compute and Postgres go to `exited` (not paused), wake the app with one request in about 230 ms and the database on connect in about 600 ms, confirm a manual stop survives traffic, set a memory limit and read it back from the container, deploy the bundled n8n template through the router, then tear down and find nothing left behind.

It did not work as first assembled. Four product bugs had to be fixed to get there, three of which broke the headline promise on a laptop:

- Local mode published a service on the container's own port, so an image serving port 80 could not deploy at all where Docker runs in a VM.
- The router raced itself on every service add, moved a lane port for no reason, and leaked a listener whose port later allocations could not bind.
- Every compute volume fork on macOS produced an empty `/data`, because the clone helper relied on GNU `cp` semantics that BSD `cp` does not share.
- The image did not build and did not boot in bridge networking, and the compose stack took its data directory from the operator's shell rather than its env file.

## Gaps, for your call

1. ~~**The in-repo template images are published amd64-only.**~~ Closed. Measured first: all seven canonical ghcr tags were amd64-only, not six, and `n8n` was the only bundled template an arm64 box could deploy. One template genuinely could not cross-build, `9router`, whose `FROM` pinned the amd64 child of its upstream index rather than the index; repinned. All seven Dockerfiles were then built for `linux/arm64` on an arm64 machine and every image started and answered its own healthcheck. `meta.architectures` is now a mandatory manifest field: the workflow derives its buildx platforms from it and verifies the pushed index against it, the catalog serves it beside this box's `hostArchitecture`, the dashboard greys out what will not run, and a deploy this box cannot run is refused before it creates a service. Every version was bumped, because the amd64-only images already published under the old tags are immutable and only a new tag can carry the fix. Still unverified: the workflow itself has not run, so the multi-arch push and the arm64 leg's build time under QEMU are unproven, and nothing has been deployed end to end on an arm64 box.
2. **No `POST /agent/sessions`.** The shipped CLI auto-enters agent mode inside an agent harness and 404s on its first call, so it can do nothing against a local daemon. The cloud has this route, so it is a missing endpoint rather than a new one, and it is the most likely first experience for exactly the audience this runtime targets.
3. **Three container suites named in the integration order were never written**: the reflink and basebackup fork variants, the data-directory migration, and the router lanes. Those paths are covered by fake suites and by the smoke run, but not by a container test.
4. **`COMPATIBILITY.md` overstates two rows.** There is no `policy` command in the current CLI, and the file should say the decision is set through the API or the dashboard.
5. **Governance is untouched and still contradictory.** The code ships twelve gated actions and an Approvals page, the README headlines it, and the docs site removed it. That decision is yours.
6. **Sign-off wanted** on the URL shape as implemented and on the idle defaults: 5 minutes for compute, 10 for databases, a 15 percent RAM floor.

Not in scope here, per the spec: `insta migrate` (it lives in the CLI repo) and scheduled backups.

## How it was built

`plans/impl/` carries the whole record: the integration contract, eight package plans, the merge ladder, the verifier findings, and the workflow scripts. Eight packages were built in parallel worktrees against that contract, merged in order, then attacked by independent reviewers whose findings are in `gap-findings.json`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
