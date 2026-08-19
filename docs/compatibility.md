# CLI & MCP compatibility

insta-oss implements the standard `insta` command surface — no daemon-only commands. This page
is the command-by-command result of running every registered CLI command and every insta-mcp
tool against the daemon. Cloud-only concepts return `501` with guidance rather than pretending
to work.

## CLI commands

| Command | insta-oss behavior |
| --- | --- |
| `status` | ✅ (`user: local`) |
| `org list` | ✅ builtin single org (`local`) |
| `project create/link/list/delete` | ✅ (delete is govern-gated) |
| `branch create/switch/delete/list` | ✅ (create = clone: db copy + bucket copy + app redeploy) |
| `branch merge <source>` | ✅ structural + additive: compute groups missing on the target materialize against its OWN db/bucket — data never merges (gated `service.add`) |
| `deploy` | ✅ image mode (govern-gated); source mode (`insta deploy ./dir`) works too — the CLI builds the image locally when the daemon 501s `/deploy-token` |
| `secrets` / `secrets list` / `secrets tree` | ✅ full bundle (gated) + the names-only project→branch→service binding tree |
| `secrets set/unset NAME [--branch] [--service]` | ✅ project-wide, branch override, or service-bound (injected only into that group's deploys); reserved names rejected (gated `secrets.write`) |
| `services list/add/remove` | ✅ (gated); `add postgres\|storage` is idempotent — one of each per project, auto-provisioned; `add redis\|mysql\|mongodb <name>` runs a private managed-db container per branch (fresh empty instance per branch clone, cloud parity) |
| `services secrets` / `set-access storage` | ✅ per-service secret names; bucket public-read ↔ private (gated `service.setAccess`) |
| `compute start/stop/suspend/status` | ✅ persistent intent (docker start/stop/pause) + live runtime state |
| `manifest` | ✅ per-branch postgres / storage / compute |
| `policy` / `policy set` | ✅ |
| `approvals list/approve/deny` (`--always`) | ✅ one-shot grants, same 202 flow |
| `events` | ✅ resource + govern timeline, agent ingest with dedup |
| `metrics` / `logs` | ✅ docker-backed (`docker stats` snapshot / `docker logs` tail — db logs included), cloud response shapes; targets `db\|compute\|redis\|mysql\|mongodb`; `logs --deploy` (deploy-event feed) → 501, use `insta events` |
| `storage list/get/delete` | ✅ object listing (prefix + cursor paging), presigned GET download, single delete — served from Garage's host port (:3900), gated `storage.read`/`storage.delete`; presigned-POST upload + bulk delete serve the console's file browser |
| `regions` | ✅ the single `local` region (this machine) |
| `login/logout` | not needed — localhost trust, no accounts |
| `services scale/upgrade` | 501 — machine scaling / instance specs are cloud pricing concepts |
| `compute limits/always-on` | 501 — tier caps / scale-to-zero are cloud pricing concepts; local containers already stay up |
| `usage` / `billing` | 501 — billing metering is cloud-only by design; local visibility = `manifest` + docker-backed `metrics`/`logs` |
| `org create` / `tokens` | 501 — single-tenant |

## MCP tools

The insta-mcp server (`insta_*` tools) is a thin client over the same endpoints — point it at
instad (`PLATFORM_API_URL=http://127.0.0.1:8080`, any non-empty bearer) and it works:

| Tools | insta-oss behavior |
| --- | --- |
| `whoami · org_list · project_* · service_add/list/remove/access · deploy · compute_control/status · branch_* · storage_list/download_url/delete · manifest · secrets_* · metrics · logs · events · policy_get · approvals_*` | ✅ end-to-end, including the full governance flow (202 → `approvals_approve`/`deny`) |
| `org_create · usage · billing_summary/checkout/portal · service_scale/upgrade · domain_* · deploy_events` | `not_supported`, carrying the daemon's 501 guidance verbatim |
| `feedback` | bypasses the control plane entirely (posts to the hosted feedback service, tagged `target: oss`) |

## Branching vs merging

`branch` = a disposable isolated environment (a clone). `insta branch merge` is **structural
only** — it materializes missing services on the target; **data never merges back**. Schema
moves at the git level: merge your code, run migration files against main, redeploy, delete
the branch environment.
