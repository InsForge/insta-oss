import { docker } from '../docker'
import type { ComputeAdapter, ServiceLimits } from '../types'

const appName = (ref: string, group: string): string => `io-${ref}-app-${group}`

// Custom compute: runs the USER's image as a container on the branch network.
// Branch model = redeploy (replace-on-deploy; state lives in the branch's db/storage).
export class DockerCompute implements ComputeAdapter {
  // Persistent /data volumes are directories under the data dir, bind-mounted below; the engine
  // creates and removes them (04 section E), so a branch fork can reflink one.
  readonly supportsVolumes = true

  async deploy(
    ref: string,
    opts: {
      image: string; port: number; envVars: Record<string, string>; network?: string; group: string; start?: boolean
      hostPort?: number; hostAliases?: string[]; volume?: { hostPath: string }; limits?: ServiceLimits
    },
  ): Promise<{ url: string }> {
    const name = appName(ref, opts.group)
    if (!opts.network) throw new Error('DockerCompute requires the branch network')
    const hostPort = opts.hostPort ?? opts.port
    try { await docker(['rm', '-f', name]) } catch { /* not running yet */ }
    const envArgs = Object.entries(opts.envVars).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    // `hostPath` is `vol/<ref>/<volId>` under the data dir, created by the engine before the deploy
    // (`volumeMount`, mode 0777 because a user image may run as any uid). `--mount type=bind`,
    // never `-v` (decision 56): with `-v` dockerd CREATES a missing host directory, so a reboot
    // where the data volume failed to mount would hand the app an empty /data on the root
    // filesystem instead of failing the start. The data survives redeploys because only the
    // container is replaced.
    const volArgs = opts.volume ? ['--mount', `type=bind,src=${opts.volume.hostPath},dst=/data`] : []
    // create + conditional start, not `run -d`: a redeploy of a service the user stopped must not
    // run its entrypoint for the length of the redeploy. `--restart unless-stopped` is unaffected:
    // it only ever restarts containers that were RUNNING when the daemon went down, so one created
    // and never started stays down.
    await docker(['create', '--restart', 'unless-stopped', '--name', name, '--network', opts.network,
      ...envArgs,
      // ---- args WP2 ---- (`-p 127.0.0.1:<hostPort>:<port>` only when hostPort is set; `--add-host <h>:host-gateway` per hostAliases)
      // host-side mapping may differ (branch clones); the app's listen port never changes
      '-p', `${hostPort}:${opts.port}`,
      // ---- args WP3 ---- (`--init`; `--cpus` / `--memory` / `--memory-swap` when limits)
      // ---- args WP4 ---- (`--mount type=bind,src=<hostPath>,dst=/data`)
      ...volArgs,
      opts.image])
    if (opts.start !== false) await docker(['start', name])
    return { url: `http://localhost:${hostPort}` }
  }

  async destroy(ref: string): Promise<void> {
    // Remove every compute group container for this branch ref.
    const out = await docker(['ps', '-aq', '--filter', `name=io-${ref}-app-`])
    const ids = out.toString().trim().split('\n').filter(Boolean)
    // `-v` drops each container's anonymous volumes with it. The branch's /data trees are
    // directories under the data dir now, and the ENGINE removes them after this call
    // (`data.remove(layout().vol(ref, id))`), so nothing here sweeps named volumes.
    if (ids.length) await docker(['rm', '-f', '-v', ...ids])
  }

  // ---- lifecycle (persistent developer intent; suspend = docker pause) ----
  // A paused container must be unpaused before start/stop can take effect.
  async start(ref: string, group: string): Promise<void> {
    const name = appName(ref, group)
    await docker(['unpause', name]).catch(() => { /* not paused */ })
    await docker(['start', name])
  }

  // `graceSec` is read by WP3 (`docker stop -t`); ignored in the scaffold.
  async stop(ref: string, group: string, _opts: { graceSec?: number } = {}): Promise<void> {
    const name = appName(ref, group)
    await docker(['unpause', name]).catch(() => { /* not paused */ })
    await docker(['stop', name])
  }

  async suspend(ref: string, group: string): Promise<void> {
    await docker(['pause', appName(ref, group)])
  }

  async rename(ref: string, from: string, to: string): Promise<void> {
    await docker(['rename', appName(ref, from), appName(ref, to)])
  }

  // Scaffold interim only (decision 53): WP3 deletes it; liveState then reads scheduler.stateOf.
  async state(ref: string, group: string): Promise<string> {
    try {
      const s = (await docker(['inspect', '-f', '{{.State.Status}}', appName(ref, group)])).toString().trim()
      if (s === 'running') return 'running'
      if (s === 'paused') return 'suspended'
      if (s === 'exited' || s === 'created' || s === 'dead') return 'stopped'
      return 'unknown'
    } catch { return 'none' }
  }
}
