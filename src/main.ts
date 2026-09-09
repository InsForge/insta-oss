#!/usr/bin/env -S npx tsx
// instad: the insta-oss daemon. Local mode binds 127.0.0.1 (localhost trust; no OAuth) and the stock
// `insta` CLI reaches it via INSTA_API_URL=http://127.0.0.1:8080. Boot order per contract 00 §1.1 /
// 01 §1: every region marker below sits in its FINAL position; WP1 fills the bodies, nobody moves a
// marker, every other package adds lines only inside its own region.
import { buildServer } from './server'
import { Engine } from './engine'
import { LocalPostgres } from './adapters/postgres'
import { DockerCompute } from './adapters/compute'
import { LocalGarage } from './adapters/garage'
import { LocalManagedDb } from './adapters/manageddb'
import { docker } from './docker'
import { resetAdmin } from './auth'
import { loadConfig, type Config } from './config'
import { mkdirSync } from 'node:fs'
import { acquireLock, initStatePath, loadState, releaseLock } from './state'
// ---- region WP4 (data dir) ----
import { capabilitiesLine, sharedDataDir } from './datadir'
// ---- end region WP4 ----
// ---- region WP2 (router) ----
import { laneReallocator, Router } from './router'
import { engineRouterDeps, routerUpstream } from './router/deps'
import { buildTable } from './router/table'
// ---- end region WP2 ----

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Local mode on Linux only: the docker bridge gateway, so a container started with
 *  `--add-host <name>:host-gateway` reaches the daemon's own listener. On Docker Desktop
 *  host.docker.internal already forwards to host loopback, so the list stays empty there. A failure
 *  is logged once and is never fatal (decision 3). */
async function bridgeGateway(cfg: Config): Promise<string[]> {
  if (cfg.mode !== 'local' || process.platform !== 'linux') return []
  try {
    const out = await docker(['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}'])
    const ip = out.toString('utf8').trim()
    if (ip) return [ip]
  } catch { /* no bridge network, or a docker without that template: warn and carry on */ }
  console.warn('warn: could not read the docker bridge gateway; containers reach the daemon through host.docker.internal only')
  return []
}

async function main(): Promise<void> {
  // config (WP1: --reset-admin runs here and exits)
  let cfg = loadConfig()
  if (process.argv.includes('--reset-admin')) process.exit(resetAdmin(cfg))
  mkdirSync(cfg.dataDir, { recursive: true })
  // state path
  initStatePath(cfg.statePath)
  // lock (WP1: instad.lock in the data dir, 20 s heartbeat; a FRESH lock is retried for up to
  // 60 s so a compose restart whose predecessor was SIGKILLed still boots)
  acquireLock(cfg.dataDir)
  process.on('exit', releaseLock)
  // docker check
  try { await docker(['version', '--format', '{{.Server.Version}}']) }
  catch { console.error('error: Docker is required and must be running (insta-oss provisions branches as containers)'); process.exit(1) }
  // extraListenHosts (local + linux: the docker bridge gateway) on a frozen copy of cfg; the
  // primary listener stays cfg.listenHost and WP2's lanes bind the extras (decision 3).
  cfg = Object.freeze({ ...cfg, extraListenHosts: await bridgeGateway(cfg) })

  // ---- region WP4 (probe) ----
  // The data directory, plus one clone attempt to learn whether this filesystem reflinks. An
  // unwritable data dir is fatal; a filesystem that cannot clone costs one warning and slower forks
  // (decision 23). `INSTA_OSS_FORK=reflink` is the operator asking to fail instead.
  const data = sharedDataDir(cfg)
  const caps = await data.probe()
  if (cfg.data.fork === 'reflink' && !caps.reflink) {
    console.error(`error: INSTA_OSS_FORK=reflink but ${cfg.dataDir} does not support reflinks`)
    process.exit(1)
  }
  console.log(capabilitiesLine(cfg, caps))
  if (caps.warning) console.warn(`warning: ${caps.warning}`)
  // ---- end region WP4 (probe) ----
  // ---- region WP3 (upstream) ----
  // Upstream + DockerRuntime; passed as EngineOptions.upstream
  // ---- end region WP3 (upstream) ----
  // ---- region WP5 (catalog) ----
  // TemplateCatalog; passed as EngineOptions.templates
  // ---- end region WP5 (catalog) ----

  const storage = new LocalGarage({ configPath: cfg.garageConfigPath, hostEndpoint: cfg.s3HostEndpoint, mode: cfg.mode, domain: cfg.domain })
  const engine = new Engine(new LocalPostgres(), new DockerCompute(), storage, new LocalManagedDb(), { cfg })

  // ---- region WP4 (migrate) ----
  // One boot migration of installs that stored data in docker volumes, BEFORE the router and the
  // scheduler start (contract 1.1): it stops and re-creates containers, so nothing may be watching
  // them or waking them meanwhile. `booting` keeps the sleep sweep inert until it finishes.
  engine.setDataCapabilities(caps)
  engine.booting = true
  try { await engine.migrateLegacyData() }
  catch (e) { console.warn(`warning: data migration did not finish: ${e instanceof Error ? e.message : String(e)}`) }
  finally { engine.booting = false }
  // ---- end region WP4 (migrate) ----
  // ---- region WP5 (executor) ----
  // executor; abandonStale; migrateLegacyContainers
  // ---- end region WP5 (executor) ----
  // ---- region WP2 (router) ----
  // The router owns the node:http server; Fastify receives it through `serverFactory` and hands its
  // request handler back inside that call (`attach`), which is the only place Fastify exposes it.
  // Dispatch is by Host: daemon names to the API, minted names and custom domains to the HTTP lane
  // (decision 4). `engine.router = router` closes the loop, so every mutate that changes a hostname
  // or a lane rebuilds the table and reconciles the listeners.
  const router = new Router({
    cfg,
    table: () => buildTable(loadState(), cfg),
    upstream: routerUpstream(engine, cfg),
    reallocLane: laneReallocator(cfg, () => engine.allocLanePort()),
    ...engineRouterDeps(engine),
  })
  engine.router = router
  // ---- end region WP2 (router) ----

  const app = buildServer(engine, cfg, { serverFactory: (handler) => { router.attach(handler); return router.httpServer } })
  await app.listen({ host: cfg.listenHost, port: cfg.port })

  // ---- region WP2 (start) ----
  // Extra listeners come up only after the primary one is bound: a lane that answers before the API
  // does would hold a wake against a daemon that cannot serve it.
  await router.start()
  // ---- end region WP2 (start) ----
  // ---- region WP3 (start) ----
  // engine.scheduler.start()
  // ---- end region WP3 (start) ----

  if (cfg.mode === 'server') {
    console.log(`instad ${cfg.version} mode=server api=${cfg.apiUrl} console=${cfg.consoleUrl} data=${cfg.dataDir}`)
    if (!loadState().identity?.admin) console.log(`setup: ${cfg.consoleUrl}/setup`)
  } else {
    console.log(`insta-oss daemon listening on http://${cfg.listenHost}:${cfg.port}`)
    console.log('point the insta CLI here (this is its default):')
    console.log('  insta project create <name>   # then branch/deploy/secrets/manifest as usual')
  }
  // ---- region WP6 ----
  // version banner: server mode only (the image bakes INSTA_OSS_VERSION; instad.env sets the tag the
  // stack runs). Local mode prints nothing extra so `npm run dev` output stays byte-identical.
  if (cfg.mode === 'server') {
    console.log(`instacloud image ${cfg.version}: re-run install.sh to upgrade (add --version vX.Y.Z to pin); templates ${cfg.templatesDir}`)
  }
  // ---- end region WP6 ----

  // signals: shut down inside the compose stop_grace_period (30 s) and never leave a fresh lock
  // behind. Order matters: stop accepting traffic, then the scheduler, then a BOUNDED app.close()
  // (SSE, WebSocket and pg splices share these sockets, so an unbounded close could outlast the
  // grace, get SIGKILLed, skip releaseLock and make the replacement container refuse the lock).
  let stopping = false
  const shutdown = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    // ---- region WP2 (stop) ----
    // The lanes stop accepting first: a lane socket spliced to a container would otherwise outlive
    // the bounded app.close() below.
    await router.stop()
    // ---- end region WP2 (stop) ----
    // ---- region WP3 (stop) ----
    // await engine.scheduler.stop()
    // ---- end region WP3 (stop) ----
    await Promise.race([app.close(), sleep(10_000)])
    releaseLock()
    process.exit(0)
  }
  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1) })
