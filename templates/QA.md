# Template QA notes

What we check before publishing a template, and the gotchas worth knowing before you author one.

Acceptance for a template: the deploy succeeds, the URL serves, auth and variables behave as the
manifest declares, and data survives a redeploy. `scripts/deploy.mjs` runs the same steps the
hosted platform runs server-side, so it is the quickest way to check a template by hand.

| Template | Deploy | URL serves | Auth and variables | Persistence | Notes |
|---|---|---|---|---|---|
| `claude-code` | yes | 401 unauthenticated, 200 authenticated | `ACCESS_PASSWORD` generated when omitted | `/data` survives update and rollback, byte-identical | ttyd terminal verified in a browser. A cold first build can exceed the platform's health-check window; the platform rolls back and a retry with a warm cache passes |
| `codex` | yes | 401, auth-gated | `ACCESS_PASSWORD` generated | same volume mechanism as `claude-code` | `@openai/codex` installs and builds clean |
| `pi` | yes | 401, auth-gated | `ACCESS_PASSWORD` generated | same volume mechanism | `@earendil-works/pi-coding-agent` installs and builds clean |
| `9router` | yes | 200 | no required variables, so a deploy needs no input | **no, see "cannot use the platform volume"** | **draft.** The volume mount is root-owned and the app runs non-root, so no manifest setting can write to `/data`. Port 20128 is correct (it is the image's exposed port); the failure is not a port mismatch |
| `hermes` | not yet | | | | Full QA needs a real `OPENROUTER_API_KEY` and Telegram tokens. Deploy and health check can be smoke-tested with placeholders |
| `dsh` | yes | 401 unauthenticated, 200 authenticated | `ACCESS_PASSWORD` generated; Settings and Models verified in a browser, key stored through `credentials.set` | `/data` holds `DSH_HOME`, `HOME` and the workspace | Two products in one container (nginx plus dsh). `hermes` and `deepseek-hermes` already background a second process, but this is the first where either half dying has to stop the container, so `wait -n` supervises both. Needed three fixes a deploy found and a build could not: bubblewrap for the sandbox, the client-side loopback guard for the Models page, and a cookie for the WebSocket handshake, accepted only when the handshake's `Origin` is this deployment's own. `GIT_TOKEN` was advertised and read by nothing; the Dockerfile now asserts every documented env name against the installed tree |
| `deepseek-hermes` | yes, and that is the problem | 200 | `HERMES_DEFAULT_MODEL` is read by nothing, so the model the name promises was never selected | not measured | **draft, delisted 2026-08-22.** A real deploy reported itself as Claude Opus over OpenRouter, 87x the input and 218x the output price of the advertised model. Superseded by `dsh`. This is what a template that deploys green while configuring nothing looks like |
| `n8n` | not yet | | | | **draft.** It declares a managed `postgres` service, and the current executor deploys web services only |
| `openclaw` | not started | | | | **draft.** Image reference and variable names are still placeholders |

## Findings

1. **Two templates on one branch can collide on a service name.** `codex` and `pi` both declare a
   service called `workspace`, so deploying both onto the same branch made the second overwrite the
   first: same service group, same URL. This is why a template deploy defaults to a fresh branch.
   Give a service a name that reads naturally for your template rather than copying `workspace`.

2. **Canonical image tags publish only from `main`.** `templates-build-images.yml` pushes
   `sha-*` and `branch-*` tags from a branch, and the version tag the manifest references only on
   merge. So a branch build can never overwrite the image a published template pulls, and testing
   an unmerged workspace template means pulling its `sha-` tag.

3. **Publish waits for the image.** `publish.mjs` checks that every `ghcr.io/...` image a manifest
   references actually resolves before it publishes, polling while the image build finishes. A
   merge therefore cannot register a manifest whose image does not exist. If the build failed
   outright, publish fails naming the missing reference, and re-running it after a fix is safe
   because publishing is an upsert.

4. **An upstream image that runs non-root cannot use the platform volume yet.** This is what keeps
   `9router` in draft, and it generalises to any such image. The platform mounts a service volume
   at `/data`, owned by `root:root`, and the manifest's `volume: { size: N }` carries a size but no
   path or ownership. 9router's entrypoint chowns its own hardcoded `/app/data`, then drops to a
   non-root user, so nothing it can write to is on the volume. Measured against
   `decolua/9router:0.5.55`:

   | Configuration | HTTP | `/data` after start | Where data actually landed |
   |---|---|---|---|
   | as authored (volume, no `DATA_DIR`) | 307 | **empty** | `/app/data/jwt-secret`, which is ephemeral |
   | `DATA_DIR=/data` | **500** | | `EACCES: permission denied, open '/data/jwt-secret'` |
   | `DATA_DIR=/data/9router` | 307 | **empty** | `/home/node/.9router/jwt-secret`, a silent fallback |
   | `HOME=/data` | 307 | **empty** | silent fallback |

   Every manifest-level lever fails, and the two that keep the service *healthy* are the dangerous
   ones: they persist nothing while looking fine. An entrypoint wrapper is not an option for a
   template that references an official upstream image, since rebuilding it is against the rules
   here. The fix belongs in the platform, or upstream has to honour `DATA_DIR` without needing to
   own its parent directory.

5. **The catalog's manifest parser is stricter than this repo's lint, so read both.** A publish run
   once rejected four of five manifests for two rules the lint did not yet enforce:
   - `image:` and `build:` are mutually exclusive. The workspace manifests carried both, `image:`
     for the prebuilt tag and `build:` left over from local experiments. The Dockerfile is wired by
     convention instead, and `image:` is the one that deploys.
   - `constraints[].oneOf` may only name variables the manifest declares. `hermes` named
     `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, neither of which it declared.

   Both are enforced by `scripts/lint.mjs` now, so this class of error fails on the pull request.

6. **`hermes` has no provider `oneOf` constraint, on purpose.** The obvious fix for the parser
   rejections above was
   to declare the two missing keys as optional, and that would have been a guess. The constraint
   was self-contradictory anyway, because `OPENROUTER_API_KEY` is required and a required variable
   is resolved before constraints are checked, so the alternatives were unreachable. Upstream says
   Hermes "works with whatever provider you want" and lists Nous Portal, OpenRouter and OpenAI
   (Anthropic is not among them), while documenting no environment variable names at all.
   Declaring them would let a deploy pass with a key the agent may never read. If you can confirm
   the upstream variable names, that is a welcome pull request.

7. **512 MB is not enough for an agent CLI, so the workspace templates declare a size.** Every
   compute service is created at 1 vCPU / 512 MB by default, and the agent CLIs are close to
   unusable there. Raising the size after a deploy is not a fix either: it rebuilds the machine and
   kills the terminal session the user is sitting in, which for a template whose whole product is
   an interactive terminal is worse than starting small. `claude-code`, `codex` and `pi` therefore
   declare `spec: 1vcpu-1gb`, which the platform honours at creation, so no resize happens at all.
   The valid names come from the platform's own catalog; `npm run lint` mirrors the list.

8. **A `healthcheck` in front of an auth gate reports the gate, not the app.** `dsh` puts nginx in
   front of the harness, and `healthcheck: /` is satisfied by nginx's unauthenticated 401 alone
   (`scripts/deploy.mjs` accepts any status under 500). So the deploy goes green as soon as nginx
   binds, while authenticated requests still 502 for the 40 to 50 seconds the harness takes to
   start listening, and a rollback cannot protect against a harness that never comes up at all.
   Making it real needs an unauthenticated location that only answers once the app is listening,
   for example a `location = /_up` with `auth_basic off` proxying upstream. The tradeoff is that
   this serves the SPA shell to anyone who asks, with every RPC still behind the gate, so it is a
   judgement rather than a free fix, and it changes what gates a deploy. Left as it is for now;
   anyone touching the health contract should know the current one only proves nginx is up.
