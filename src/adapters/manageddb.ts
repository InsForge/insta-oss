import { docker } from '../docker'
import { MANAGED_DB } from '../manageddb'
import type { ManagedDbAdapter, ManagedDbTarget, ServiceLimits } from '../types'

// One managed-database container per branch per service (valkey/mysql/mongo), on the branch
// network only, so it is private like the cloud's private-tcp `.internal` hosts: reachable from the
// branch's compute containers at <container-name>:<port>. Handles are the container names the
// engine passes in. Scaffold interim: `dataDir` is ignored when '' (data lives in the container's
// own layer; WP4 bind-mounts it), `publishLoopback`/`limits` are read by WP2/WP3 at the marked lines.
export class LocalManagedDb implements ManagedDbAdapter {
  async provision(t: ManagedDbTarget, opts: { publishLoopback?: boolean; limits?: ServiceLimits } = {}): Promise<void> {
    const cfg = MANAGED_DB[t.type]
    const envArgs = Object.entries(cfg.env(t.password)).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    await docker(['run', '-d', '--restart', 'unless-stopped', '--name', t.container,
      '--network', t.network, ...envArgs,
      // ---- args WP2 ----
      // Local mode only (same reason as postgres): an ephemeral loopback port for `docker port`.
      ...(opts.publishLoopback ? ['-p', `127.0.0.1::${cfg.port}`] : []),
      // ---- args WP3 ----
      // ---- args WP4 ----
      cfg.image, ...(cfg.cmd ?? [])])
  }

  async destroy(container: string): Promise<void> {
    try { await docker(['rm', '-f', container]) } catch { /* already gone */ }
  }

  async rename(container: string, to: string): Promise<void> {
    // docker's embedded DNS follows the rename, so the re-minted bundle's new host resolves.
    await docker(['rename', container, to])
  }
}
