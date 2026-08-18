import { docker } from '../docker'
import { MANAGED_DB, managedContainerName } from '../manageddb'
import type { ManagedDbAdapter, ManagedDbType } from '../types'

// One managed-database container per branch per service (valkey/mysql/mongo), on the branch
// network only — no host port mapping, so it is private like the cloud's private-tcp `.internal`
// hosts: reachable from the branch's compute containers at <container-name>:<port>. Data lives in
// the container's own layer; it survives restarts and is destroyed with the service or branch —
// exactly the lifetime the cloud gives it (a branch clone starts empty; there is no data clone).
export class LocalManagedDb implements ManagedDbAdapter {
  async provision(ref: string, network: string, type: ManagedDbType, name: string, password: string): Promise<void> {
    const cfg = MANAGED_DB[type]
    const envArgs = Object.entries(cfg.env(password)).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    await docker(['run', '-d', '--restart', 'unless-stopped', '--name', managedContainerName(ref, type, name),
      '--network', network, ...envArgs, cfg.image, ...(cfg.cmd ?? [])])
  }

  async destroy(ref: string, type: ManagedDbType, name: string): Promise<void> {
    try { await docker(['rm', '-f', managedContainerName(ref, type, name)]) } catch { /* already gone */ }
  }

  async rename(ref: string, type: ManagedDbType, from: string, to: string): Promise<void> {
    // docker's embedded DNS follows the rename, so the re-minted bundle's new host resolves.
    await docker(['rename', managedContainerName(ref, type, from), managedContainerName(ref, type, to)])
  }
}
