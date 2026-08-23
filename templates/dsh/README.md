# DeepSeek Harness

DeepSeek's plugin-composed coding agent, with its browser UI behind an auth gate.

> **This one needs a maintainer watching upstream.** DeepSeek Harness describes itself as a
> developer preview and says there will be compatibility-breaking changes, and the version pinned
> here is a release candidate whose transitive dependency ranges float. Treat a version bump as a
> change that needs re-testing, not as a routine edit.

## Overview

This template runs [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), the
agent DeepSeek publishes as `@deepseek-ai/dsh`, in its browser UI mode. You open a URL,
authenticate, and get the harness web interface: sessions, a model picker, the agent's file and
shell tools, skills, plans, goals and subagents. The harness is composed entirely of plugins on
top of [Cordis](https://github.com/cordiverse/cordis), and `dsh plugin` is available in the
container for adding more.

The image is built from the Dockerfile in this directory: `node:24-bookworm-slim` (pinned by
digest), `nginx-light` from Debian, and `@deepseek-ai/dsh` pinned to an exact version. Nothing
floats on `latest`, so a restart gives you the same environment.

**Why there is an nginx in front.** The harness web UI has no authentication of any kind, and it
drives an agent that runs shell commands, so upstream refuses to bind it to anything but
loopback: `dsh web --host 0.0.0.0` exits with "intentionally not supported yet for safety: it
would expose remote code execution to the network". This template honours that. The harness
listens on `127.0.0.1:3080` exactly as upstream intends, and an nginx in the same container is
the only process on the public port. It requires HTTP basic auth, and it normalizes the `Host`
and `Origin` headers to the loopback authority, because the harness pins its settings,
credential and model-discovery calls to a loopback origin and would otherwise answer them with
403 from behind a public hostname.

**Why the image relaxes one client-side check.** Rewriting those headers is only half of what the
Settings and Models pages need, because the harness applies the same loopback test twice. The
server pins its 15 privileged RPCs to a loopback `Host`, which the rewrite above satisfies, and
the browser bundle separately reads the page's own `location.hostname`. When that is not loopback
the settings mirror is built in a memory-only mode where it never sends `settings.describe` at
all, and the Models page renders "settings are unavailable in this browser" with no request made
and no error logged. Upstream gives up there on the premise that a remote browser could not reach
those RPCs anyway, which is no longer true once the proxy normalizes `Host`, so the build rewrites
that one expression to a constant. It changes what the UI offers, not what the API allows: the
same RPCs are reachable through the gate either way, the gate in front of them is unchanged, and
the server's own refusal of cross-site requests is left alone. The build asserts the upstream
expression appears exactly once before rewriting it, so a version bump that restructures it fails
the image build instead of quietly shipping a dead Models page.

**Why the gate hands out a cookie.** The UI receives everything the agent does over two
WebSockets, `/api/events.host` and `/api/events.mux`. `new WebSocket()` takes no headers, so a
browser can only authenticate that handshake with credentials its own network stack attaches, and
nothing requires an engine to reuse its HTTP auth cache there. Measured with a page holding valid
basic credentials, Chromium and Firefox attach them to the handshake and WebKit sends none. Where
they are not attached both handshakes answer 401, the client retries them forever, and the agent's
output never reaches the page, even though the page itself and every RPC on it are authenticated
normally. So the gate mints a cookie on the authenticated responses that do not already carry one,
and accepts it in place of the password on a WebSocket handshake and nowhere else. Its value is a
digest of `ACCESS_PASSWORD`, so rotating the password invalidates every cookie issued under the
old one, and it is `HttpOnly` and `SameSite=Strict`, so no script can read it and it is never
attached to a cross-site request. Ordinary requests are unaffected: they still need the password.

## What you get by hosting it

- An HTTPS URL for the harness UI, gated by HTTP basic auth, with no port forwarding or tunnel.
- A 1 GiB volume mounted at `/data`. `DSH_HOME` is `/data/dsh` and `HOME` is `/data/home`, so
  settings, stored credentials, session history, installed plugins and your files survive
  restarts, redeploys and version upgrades.
- The access password stored as a managed secret rather than baked into the image.
- 1 vCPU and 1 GiB of memory, declared by the template so the machine is created at that size
  rather than resized later.
- Deploys are health-gated: a container that does not answer is rolled back to the last healthy
  image instead of leaving you with a dead URL.

## What you need before deploying

- Nothing mandatory. The access password is generated for you if you leave it blank.
- Optionally, a [DeepSeek API key](https://platform.deepseek.com/). You can also leave it blank
  and store one from the UI's Models page after deploy, which keeps it editable in the UI.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ACCESS_PASSWORD` | yes | HTTP basic-auth password for the UI, username `admin`. Generated (16 chars) when left blank; editable afterwards. |
| `DEEPSEEK_API_KEY` | no | The key the agent uses for model calls and for its `web_search` tool. Leave blank to store one from the Models page instead. |
| `DEEPSEEK_BASE_URL` | no | Points the DeepSeek adapter at a gateway or compatible proxy. Defaults to `https://api.deepseek.com`. |
| `DSH_PERMISSION_MODE` | no | The agent's file boundary: `read-only`, `workspace-write` (the default), or `danger-full-access`. You should not need to widen it: the sandbox runs through bubblewrap, which the image installs for exactly this reason. |

There is deliberately no `GIT_TOKEN`. Earlier revisions of this template advertised one, but
nothing in the harness reads that name, so it configured nothing. To clone a private repository,
give the agent a URL carrying the token, or write a credential helper under `/data/home`.

Set by the template, not by you: `DSH_HOME=/data/dsh` and `HOME=/data/home` (put all harness
state on the volume), and `DSH_TELEMETRY_DISABLED=1`. Session telemetry is already off by default
(`DSH_TELEMETRY_MODE` defaults to `DISABLED`); this disables the row outright. It stops telemetry
export only, and does not suppress feedback acknowledgement or the DeepSeek provider header.

One thing to know about `DEEPSEEK_API_KEY`: the harness resolves credentials from the process
environment first, and that layer is deliberately read-only, so a key supplied as a template
variable shows in the Models page as configured but not editable there. Rotate it by editing the
service variable. If you would rather manage the key in the UI, leave the variable blank; the
key you store then lives in `$DSH_HOME/.credentials.yaml` on the volume.

## After deploy

1. Open the service URL. The browser asks for HTTP basic auth: username `admin`, password
   `ACCESS_PASSWORD`. If it was generated, read it from the service's variables.
2. You land in the harness UI with no sessions yet. Start one; it opens with the `standard` agent
   preset, which is the full coding agent.
3. If you left `DEEPSEEK_API_KEY` blank, open Settings and then Models, and store your key
   there. The harness is built for this order: you can browse the model catalogue, store the
   key, and prompt, with no restart in between.
4. The agent's working directory is `/data/workspace`. Clone your repository there so your work
   persists. Files written outside `/data` are lost when the container is replaced.
5. Session history, settings and stored credentials are under `/data/dsh` and survive restarts.

The four agent presets shipped by upstream (`standard`, `code`, `minimal`, `cordis`) carry
Chinese names and descriptions in the preset picker. The rest of the UI follows your browser's
language, and you can pin it from Settings.

## Links

- Upstream: <https://github.com/deepseek-ai/deepseek-harness>
- Package: [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)
- Cordis: <https://github.com/cordiverse/cordis>
- License: DeepSeek Harness is MIT. The Dockerfile, nginx config and manifest in this directory
  are part of this repository. "DeepSeek Harness" is a registered trademark of DeepSeek, used
  here only to name the software this template deploys.
