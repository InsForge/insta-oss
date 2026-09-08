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
import { loadConfig } from './config'
import { initStatePath, acquireLock, releaseLock } from './state'

async function main(): Promise<void> {
  // config (WP1: --reset-admin runs here and exits)
  const cfg = loadConfig()
  // state path
  initStatePath(cfg.statePath)
  // lock (WP1: <dataDir>/instad.lock heartbeat)
  acquireLock(cfg.dataDir)
  // docker check
  try { await docker(['version', '--format', '{{.Server.Version}}']) }
  catch { console.error('error: Docker is required and must be running (insta-oss provisions branches as containers)'); process.exit(1) }
  // WP1: extraListenHosts (local + linux: the docker bridge gateway), stored on a frozen copy of cfg

  // ---- region WP4 (probe) ----
  // DataDir + probe(); passed as EngineOptions.data
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
  // engine.booting; migrateLegacyData
  // ---- end region WP4 (migrate) ----
  // ---- region WP5 (executor) ----
  // executor; abandonStale; migrateLegacyContainers
  // ---- end region WP5 (executor) ----
  // ---- region WP2 (router) ----
  // new Router(...) (needs engine methods); engine.router = router; serverFactory
  // ---- end region WP2 (router) ----

  const app = buildServer(engine, cfg)
  await app.listen({ host: cfg.listenHost, port: cfg.port })

  // ---- region WP2 (start) ----
  // await router.start()
  // ---- end region WP2 (start) ----
  // ---- region WP3 (start) ----
  // engine.scheduler.start()
  // ---- end region WP3 (start) ----

  // banner (WP1: server-mode banner + setup hint)
  console.log(`insta-oss daemon listening on http://${cfg.listenHost}:${cfg.port}`)
  console.log('point the insta CLI here (this is its default):')
  console.log('  insta project create <name>   # then branch/deploy/secrets/manifest as usual')
  // ---- region WP6 ----
  // version banner
  // ---- end region WP6 ----

  // signals (WP1: bounded close so the compose stop_grace_period is respected and the lock is released)
  let stopping = false
  const shutdown = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    // ---- region WP2 (stop) ----
    // await router.stop()
    // ---- end region WP2 (stop) ----
    // ---- region WP3 (stop) ----
    // await engine.scheduler.stop()
    // ---- end region WP3 (stop) ----
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 10_000))]).catch(() => { /* best-effort */ })
    releaseLock()
    process.exit(0)
  }
  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1) })
