import { docker } from '../docker'
import type { ComputeAdapter } from '../types'

const appName = (ref: string, group: string): string => `io-${ref}-app-${group}`

// Custom compute: runs the USER's image as a container on the branch network.
// Branch model = redeploy (replace-on-deploy; state lives in the branch's db/storage).
export class DockerCompute implements ComputeAdapter {
  async deploy(
    ref: string,
    opts: { image: string; port: number; envVars: Record<string, string>; network: string; group: string },
  ): Promise<{ url: string }> {
    const name = appName(ref, opts.group)
    try { await docker(['rm', '-f', name]) } catch { /* not running yet */ }
    const envArgs = Object.entries(opts.envVars).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    await docker(['run', '-d', '--name', name, '--network', opts.network,
      ...envArgs, '-p', `${opts.port}:${opts.port}`, opts.image])
    return { url: `http://localhost:${opts.port}` }
  }

  async destroy(ref: string): Promise<void> {
    // Remove every compute group container for this branch ref.
    const out = await docker(['ps', '-aq', '--filter', `name=io-${ref}-app-`])
    const ids = out.toString().trim().split('\n').filter(Boolean)
    if (ids.length) await docker(['rm', '-f', ...ids])
  }
}
