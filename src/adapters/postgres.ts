import { docker } from '../docker'
import type { DatabaseAdapter, PgTarget, ServiceLimits } from '../types'

const PASS = 'insta'
const DB = 'app'
const IMAGE = 'postgres:16-alpine'

// One Postgres container per branch database. Handles are container names the engine passes in
// (`io-<ref>-pg-<name>`). Scaffold interim (WP4 rewrites this file): `dataDir` is ignored when '' (data
// stays in the container layer), the password is the constant above, and `fork` = provision the
// destination then pipe pg_dump of the source into it (today's copy model).
export class LocalPostgres implements DatabaseAdapter {
  async provision(t: PgTarget, opts: { publishLoopback?: boolean; limits?: ServiceLimits } = {}): Promise<{ url: string }> {
    // Preload pg_stat_statements so `insta` query-stats observability works; the official image
    // treats leading-dash args as postgres server flags.
    await docker(['run', '-d', '--restart', 'unless-stopped', '--name', t.container, '--network', t.network,
      '-e', `POSTGRES_PASSWORD=${PASS}`, '-e', `POSTGRES_DB=${DB}`,
      // ---- args WP2 ----
      // Local mode only: an ephemeral loopback port the daemon finds with `docker port`, because
      // macOS cannot route to container IPs. Server mode publishes nothing.
      ...(opts.publishLoopback ? ['-p', '127.0.0.1::5432'] : []),
      // ---- args WP3 ----
      // ---- args WP4 ----
      IMAGE, '-c', 'shared_preload_libraries=pg_stat_statements'])
    await this.waitReady(t.container)
    return { url: `postgres://postgres:${PASS}@${t.container}:5432/${DB}` }
  }

  /** Scaffold interim: provision `dst`, then pg_dump the source into it. Returns the clone's own URL
   *  (the destination's password, as today: a dump carries no role passwords). */
  async fork(
    src: PgTarget & { url: string }, dst: PgTarget,
    opts: { publishLoopback?: boolean; limits?: ServiceLimits; ensureSourceRunning?: () => Promise<void> } = {},
  ): Promise<{ url: string; method: 'reflink' | 'basebackup'; ms: number }> {
    const t0 = Date.now()
    await opts.ensureSourceRunning?.()
    const { url } = await this.provision(dst, { publishLoopback: opts.publishLoopback, limits: opts.limits })
    const dump = await docker(['exec', src.container, 'pg_dump', '-U', 'postgres', '-d', DB])
    await docker(['exec', '-i', dst.container, 'psql', '-U', 'postgres', '-d', DB, '-q'], { input: dump })
    return { url, method: 'basebackup', ms: Date.now() - t0 }
  }

  async query(container: string, sql: string): Promise<string> {
    const out = await docker(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', DB,
      '-v', 'ON_ERROR_STOP=1', '-tAc', sql])
    return out.toString().trim()
  }

  async destroy(container: string): Promise<void> {
    try { await docker(['rm', '-f', container]) } catch { /* already gone */ }
  }

  async rename(container: string, to: string): Promise<void> {
    await docker(['rename', container, to])
  }

  private async waitReady(container: string, tries = 40): Promise<void> {
    for (let i = 0; i < tries; i++) {
      try { await docker(['exec', container, 'pg_isready', '-U', 'postgres', '-d', DB]); return } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error(`postgres "${container}" never became ready`)
  }
}
