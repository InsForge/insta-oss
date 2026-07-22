import { spawn } from 'node:child_process'

/** Run the `docker` CLI, capture stdout as a Buffer, feed optional stdin. Rejects on non-zero exit.
 *  `mergeStderr` folds stderr into the captured output — `docker logs` replays the container's own
 *  stderr stream there (Postgres logs entirely to stderr), which is data, not error noise. */
export function docker(args: string[], opts: { input?: Buffer; mergeStderr?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    p.stdout.on('data', (d: Buffer) => out.push(d))
    p.stderr.on('data', (d: Buffer) => { if (opts.mergeStderr) out.push(d); else err += d.toString() })
    p.on('error', reject)
    p.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`docker ${args.join(' ')} -> exit ${code}: ${err.trim()}`)),
    )
    p.stdin.end(opts.input ?? undefined)
  })
}
