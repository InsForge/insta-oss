#!/usr/bin/env -S npx tsx
// instad — the Instacloud-oss local daemon. Binds 127.0.0.1 (localhost trust; no OAuth).
// The stock `insta` CLI defaults to http://localhost:8080, so an unconfigured CLI Just Works.
import { buildServer } from './server'
import { Engine } from './engine'
import { LocalPostgres } from './adapters/postgres'
import { DockerCompute } from './adapters/compute'
import { LocalMinio } from './adapters/storage'
import { docker } from './docker'

const port = Number(process.env.INSTA_OSS_PORT ?? process.argv[process.argv.indexOf('--port') + 1] ?? 8080)

async function main(): Promise<void> {
  try { await docker(['version', '--format', '{{.Server.Version}}']) }
  catch { console.error('error: Docker is required and must be running (insta-oss provisions branches as containers)'); process.exit(1) }

  const engine = new Engine(new LocalPostgres(), new DockerCompute(), new LocalMinio())
  const app = buildServer(engine)
  await app.listen({ host: '127.0.0.1', port })
  console.log(`insta-oss daemon listening on http://127.0.0.1:${port}`)
  console.log('point the insta CLI here (this is its default):')
  console.log('  insta project create <name>   # then branch/deploy/secrets/manifest as usual')
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1) })
