import { docker } from '../docker'
import type { DatabaseAdapter } from '../types'

const PASS = 'insta'
const DB = 'app'
const IMAGE = 'postgres:16-alpine'
const pgName = (ref: string): string => `io-${ref}-pg`

// One Postgres container per branch; `ref` identifies the branch. Branch model = copy:
// cloneInto pipes pg_dump of the source into the (already provisioned) destination.
export class LocalPostgres implements DatabaseAdapter {
  async provision(ref: string, network: string): Promise<{ url: string }> {
    // Preload pg_stat_statements so `insta` query-stats observability works; the official image
    // treats leading-dash args as postgres server flags.
    await docker(['run', '-d', '--restart', 'unless-stopped', '--name', pgName(ref), '--network', network,
      '-e', `POSTGRES_PASSWORD=${PASS}`, '-e', `POSTGRES_DB=${DB}`, IMAGE,
      '-c', 'shared_preload_libraries=pg_stat_statements'])
    await this.waitReady(ref)
    return { url: `postgres://postgres:${PASS}@${pgName(ref)}:5432/${DB}` }
  }

  async query(ref: string, sql: string): Promise<string> {
    const out = await docker(['exec', '-i', pgName(ref), 'psql', '-U', 'postgres', '-d', DB,
      '-v', 'ON_ERROR_STOP=1', '-tAc', sql])
    return out.toString().trim()
  }

  async cloneInto(srcRef: string, dstRef: string): Promise<void> {
    const dump = await docker(['exec', pgName(srcRef), 'pg_dump', '-U', 'postgres', '-d', DB])
    await docker(['exec', '-i', pgName(dstRef), 'psql', '-U', 'postgres', '-d', DB, '-q'], { input: dump })
  }

  async destroy(ref: string): Promise<void> {
    try { await docker(['rm', '-f', pgName(ref)]) } catch { /* already gone */ }
  }

  private async waitReady(ref: string, tries = 40): Promise<void> {
    for (let i = 0; i < tries; i++) {
      try { await docker(['exec', pgName(ref), 'pg_isready', '-U', 'postgres', '-d', DB]); return } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error(`postgres for "${ref}" never became ready`)
  }
}
