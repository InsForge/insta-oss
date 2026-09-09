// install.sh (WP6 packaging): the installer's --print-* modes render the stack's files as pure
// functions of flags and environment (no root, no side effects), so the contract between the script,
// src/config.ts and the compose stack is testable without a VM (plan 06 "Tests"; contract 00 §15).
// Everything that needs Docker lives in compose.int.test.ts and image.int.test.ts.
import { test, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_KEYS } from '../src/config'

const ROOT = join(__dirname, '..')
const SCRIPT = join(ROOT, 'install.sh')
const script = readFileSync(SCRIPT, 'utf8')

// A minimal environment: PATH plus the keys the case sets, so a developer's own INSTA_OSS_* variables
// never leak into an assertion (the script passes every INSTA_OSS_* it sees through to instad.env).
const baseEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
const run = (args: string[], env: Record<string, string> = {}): string =>
  execFileSync('sh', [SCRIPT, ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8' })
const tryRun = (args: string[], env: Record<string, string> = {}) =>
  spawnSync('sh', [SCRIPT, ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8' })

/** KEY=VALUE lines of a rendered instad.env (comments dropped). */
const parseEnv = (out: string): Record<string, string> =>
  Object.fromEntries(out.split('\n')
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }))

const hasShellcheck = spawnSync('sh', ['-c', 'command -v shellcheck'], { encoding: 'utf8' }).status === 0

test('sh -n install.sh exits 0 (POSIX sh, not bash)', () => {
  const r = spawnSync('sh', ['-n', SCRIPT], { encoding: 'utf8' })
  expect(r.stderr).toBe('')
  expect(r.status).toBe(0)
  expect(script.startsWith('#!/usr/bin/env sh\n')).toBe(true)
  expect(script).toContain('set -eu')
})

test.skipIf(!hasShellcheck)('shellcheck -s sh install.sh is clean (CI runs the same command)', () => {
  const r = spawnSync('shellcheck', ['-s', 'sh', SCRIPT], { encoding: 'utf8' })
  expect(r.stdout + r.stderr).toBe('')
  expect(r.status).toBe(0)
})

test('--print-env writes every key loadConfig reads plus the stack-only keys, with the server defaults', () => {
  const env = parseEnv(run(['--print-env'], { INSTA_OSS_DOMAIN: 'example.test', INSTA_OSS_SECRET: 'deadbeef' }))
  for (const k of CONFIG_KEYS) expect(env, `missing ${k}`).toHaveProperty(k)
  for (const k of ['INSTA_OSS_IMAGE', 'INSTA_OSS_VERSION', 'INSTA_OSS_TLS', 'INSTA_OSS_ACME_EMAIL']) expect(env).toHaveProperty(k)
  expect(env).toMatchObject({
    INSTA_OSS_MODE: 'server',
    INSTA_OSS_DOMAIN: 'example.test',
    INSTA_OSS_SECRET: 'deadbeef',
    INSTA_OSS_DATA_DIR: '/var/lib/instacloud',
    INSTA_OSS_LISTEN_HOST: '127.0.0.1',   // the edge is the only remote client (decision 3)
    INSTA_OSS_PORT: '8080',
    INSTA_OSS_INTERNAL_PORT: '8081',
    INSTA_OSS_TRUST_PROXY: '1',
    INSTA_OSS_AUTH: '1',
    INSTA_OSS_LANE_BIND: '0.0.0.0',
    INSTA_OSS_UI_DIST: '/app/ui/dist',    // where the Dockerfile puts them
    INSTA_OSS_TEMPLATES_DIR: '/app/templates',
    INSTA_OSS_IMAGE: 'ghcr.io/insforge/instacloud',
    INSTA_OSS_TLS: 'acme',
    INSTA_OSS_ACME_EMAIL: '',
    INSTA_OSS_SCHEDULER: '1',
    INSTA_OSS_IDLE_COMPUTE_SEC: '300',
    INSTA_OSS_IDLE_DB_SEC: '600',
    INSTA_OSS_RAM_FLOOR_PCT: '15',
    INSTA_OSS_ALWAYS_ON_DEFAULT: '0',
  })
  // derived-while-empty keys stay empty so the daemon computes them from DOMAIN and DATA_DIR
  for (const k of ['INSTA_OSS_STATE', 'INSTA_OSS_GARAGE_CONFIG', 'INSTA_OSS_S3_HOST_ENDPOINT', 'INSTA_OSS_API_URL', 'INSTA_OSS_CONSOLE_URL', 'INSTA_OSS_TLS_CERT_DIR']) expect(env[k]).toBe('')
  // no key is written twice (compose's env_file would take the last one silently)
  const keys = run(['--print-env'], { INSTA_OSS_DOMAIN: 'example.test' }).split('\n').filter((l) => /^INSTA_OSS_/.test(l)).map((l) => l.split('=')[0])
  expect(new Set(keys).size).toBe(keys.length)
  // print mode never mints a secret when the environment has none: a 64-hex one is generated
  const minted = parseEnv(run(['--print-env'], { INSTA_OSS_DOMAIN: 'example.test' })).INSTA_OSS_SECRET
  expect(minted).toMatch(/^[0-9a-f]{64}$/)
})

test('--print-env: precedence flag > environment > default; --version strips the v; an image tag is the version', () => {
  const flag = parseEnv(run(['--print-env', '--domain', 'flag.test', '--tls', 'internal', '--version', 'v1.2.3', '--email', 'ops@flag.test'],
    { INSTA_OSS_DOMAIN: 'env.test', INSTA_OSS_TLS: 'acme', INSTA_OSS_SECRET: 'x' }))
  expect(flag).toMatchObject({ INSTA_OSS_DOMAIN: 'flag.test', INSTA_OSS_TLS: 'internal', INSTA_OSS_VERSION: '1.2.3', INSTA_OSS_ACME_EMAIL: 'ops@flag.test' })
  const tagged = parseEnv(run(['--print-env'], { INSTA_OSS_DOMAIN: 'example.test', INSTA_OSS_IMAGE: 'ghcr.io/insforge/instacloud:ci' }))
  expect(tagged).toMatchObject({ INSTA_OSS_IMAGE: 'ghcr.io/insforge/instacloud', INSTA_OSS_VERSION: 'ci' })
  expect(parseEnv(run(['--print-env'], { INSTA_OSS_DOMAIN: 'Example.TEST.' })).INSTA_OSS_DOMAIN).toBe('example.test')
})

test('--print-env rejects a bad --tls, a relative --data-dir, a malformed domain and an unknown flag', () => {
  expect(tryRun(['--print-env', '--tls', 'selfsigned'], { INSTA_OSS_DOMAIN: 'x.test' })).toMatchObject({ status: 1, stderr: expect.stringContaining('--tls must be acme or internal') })
  expect(tryRun(['--print-env', '--data-dir', 'relative/dir'], { INSTA_OSS_DOMAIN: 'x.test' })).toMatchObject({ status: 1, stderr: expect.stringContaining('absolute path') })
  expect(tryRun(['--print-env'], { INSTA_OSS_DOMAIN: 'bad_domain!' })).toMatchObject({ status: 1, stderr: expect.stringContaining('domain must match') })
  expect(tryRun(['--print-env'], { INSTA_OSS_PUBLIC_IP: 'not-an-ip' })).toMatchObject({ status: 1, stderr: expect.stringContaining('INSTA_OSS_PUBLIC_IP') })
  expect(tryRun(['--nope'])).toMatchObject({ status: 1, stderr: expect.stringContaining('unknown flag --nope') })
  expect(tryRun(['--help']).status).toBe(0)
})

test('INSTA_OSS_PUBLIC_IP=203.0.113.7 --print-env yields INSTA_OSS_DOMAIN=203-0-113-7.sslip.io', () => {
  const env = parseEnv(run(['--print-env'], { INSTA_OSS_PUBLIC_IP: '203.0.113.7' }))
  expect(env.INSTA_OSS_DOMAIN).toBe('203-0-113-7.sslip.io')
  expect(env.INSTA_OSS_PUBLIC_IP).toBe('203.0.113.7')
  // an explicit domain wins over the auto one; the ip is still recorded for the daemon's DNS hints
  expect(parseEnv(run(['--print-env'], { INSTA_OSS_PUBLIC_IP: '203.0.113.7', INSTA_OSS_DOMAIN: 'shop.example' })).INSTA_OSS_DOMAIN).toBe('shop.example')
})

test('pass-through: INSTA_OSS_IDLE_COMPUTE_SEC=15 and an unknown INSTA_OSS_* key land in --print-env', () => {
  const env = parseEnv(run(['--print-env'], { INSTA_OSS_DOMAIN: 'example.test', INSTA_OSS_IDLE_COMPUTE_SEC: '15', INSTA_OSS_FUTURE_KNOB: 'yes' }))
  expect(env.INSTA_OSS_IDLE_COMPUTE_SEC).toBe('15')
  expect(env.INSTA_OSS_FUTURE_KNOB).toBe('yes')
  // a non-INSTA_OSS variable is never written
  expect(run(['--print-env'], { INSTA_OSS_DOMAIN: 'example.test', HOME: '/root', SOMETHING_ELSE: '1' })).not.toMatch(/^(HOME|SOMETHING_ELSE)=/m)
})

test('--print-compose: host networking, the socket and the data dir bound at the identical path, the three container names, no ports on instad', () => {
  const out = run(['--print-compose'])
  expect(out).toContain('name: instacloud')
  expect(out).toContain('image: ${INSTA_OSS_IMAGE}:${INSTA_OSS_VERSION}')
  expect(out).toContain('- /var/run/docker.sock:/var/run/docker.sock')
  expect(out).toContain('- /var/lib/instacloud:/var/lib/instacloud')
  expect(out).toContain('env_file: instad.env')
  for (const c of ['io-instad', 'io-edge', 'io-garage']) expect(out).toContain(`container_name: ${c}`)
  const instad = out.slice(out.indexOf('  instad:'), out.indexOf('  edge:'))
  expect(instad).toContain('network_mode: host')
  expect(instad).toContain('init: true')
  expect(instad).toContain('stop_grace_period: 30s')
  expect(instad).toContain('restart: unless-stopped')
  expect(instad).not.toContain('ports:')
  const edge = out.slice(out.indexOf('  edge:'), out.indexOf('  garage:'))
  expect(edge).toContain('network_mode: host')
  expect(edge).toContain('- ./Caddyfile:/etc/caddy/Caddyfile:ro')
  expect(edge).toContain('/var/lib/instacloud/caddy/data:/data')     // the cert store the daemon reads (INSTA_OSS_TLS_CERT_DIR)
  const garage = out.slice(out.indexOf('  garage:'))
  expect(garage).not.toContain('network_mode: host')                 // stays on the bridge: the daemon attaches it to branch networks
  expect(garage).toContain('- 127.0.0.1:3900:3900')
  expect(garage).toContain('- 127.0.0.1:3902:3902')
  expect(garage).toContain('/var/lib/instacloud/garage/garage.toml:/etc/garage.toml:ro')
  // decision 46: the compose name must equal the handle the storage adapter execs into, which is
  // the one constant the adapter and the engine share.
  expect(readFileSync(join(ROOT, 'src', 'manageddb.ts'), 'utf8')).toContain("export const GARAGE_CONTAINER = 'io-garage'")
  expect(readFileSync(join(ROOT, 'src', 'adapters', 'garage.ts'), 'utf8')).toContain('const GARAGE = GARAGE_CONTAINER')
  // The data directory is the one value baked in, and on purpose: compose interpolation lets the
  // calling shell outrank --env-file, so a stray INSTA_OSS_DATA_DIR in an operator's environment
  // would move every bind above. The image and the version stay late-bound, so editing instad.env
  // is still how the running tag changes.
  const elsewhere = run(['--print-compose'], { INSTA_OSS_DATA_DIR: '/srv/x', INSTA_OSS_VERSION: '9.9.9' })
  expect(elsewhere).toContain('- /srv/x:/srv/x')
  expect(elsewhere).toContain('- /srv/x/garage/meta:/var/lib/garage/meta')
  expect(elsewhere).toContain('image: ${INSTA_OSS_IMAGE}:${INSTA_OSS_VERSION}')
  expect(elsewhere).not.toContain('9.9.9')
  expect(elsewhere).not.toContain('/var/lib/instacloud')
})

test('--print-caddyfile: ask on the internal port, on_demand, acme then internal; --tls internal drops issuer acme', () => {
  const acme = run(['--print-caddyfile'], { INSTA_OSS_TLS: 'acme' })
  expect(acme).toContain('ask http://127.0.0.1:8081/tls/ask')
  expect(acme).toContain('admin off')
  expect(acme).toContain('on_demand')
  expect(acme.indexOf('issuer acme')).toBeGreaterThan(-1)
  expect(acme.indexOf('issuer acme')).toBeLessThan(acme.indexOf('issuer internal'))
  expect(acme).toContain('reverse_proxy 127.0.0.1:8080')
  expect(acme).toContain('header_up X-Forwarded-Proto https')
  expect(acme).toContain('redir https://{host}{uri} permanent')
  expect(acme).not.toContain('email')                       // omitted when INSTA_OSS_ACME_EMAIL is empty
  const internal = run(['--print-caddyfile'], { INSTA_OSS_TLS: 'internal', INSTA_OSS_ACME_EMAIL: 'ops@example.test' })
  expect(internal).not.toContain('issuer acme')
  expect(internal).toContain('issuer internal')
  expect(internal).toContain('email ops@example.test')
  // the ports follow instad.env, not the defaults
  const moved = run(['--print-caddyfile'], { INSTA_OSS_PORT: '9080', INSTA_OSS_INTERNAL_PORT: '9081' })
  expect(moved).toContain('ask http://127.0.0.1:9081/tls/ask')
  expect(moved).toContain('reverse_proxy 127.0.0.1:9080')
})

test('the fstab line makes docker.service wait for the data mount (decision 56)', () => {
  expect(script).toContain('"$IMG $DATA xfs loop,nofail,x-systemd.required-by=docker.service,x-systemd.before=docker.service 0 0"')
  expect(script).toContain('mkfs.xfs -q -m reflink=1')
  expect(script).toContain('cp --reflink=always')
})

test('--print-daemon-json renders the branch-network address pool; the script greps daemon.json before writing', () => {
  expect(JSON.parse(run(['--print-daemon-json']))).toEqual({ 'default-address-pools': [{ base: '10.100.0.0/14', size: 24 }] })
  expect(script).toMatch(/grep -q '"default-address-pools"' "\$DAEMON_JSON"/)
  expect(script).toContain('restart_docker')
})

test('--print-firewall lists the docker0 and inbound rules; the script gates them on ufw status / firewall-cmd --state', () => {
  const out = run(['--print-firewall'])
  expect(out).toContain('ufw allow in on docker0 to any port 443,5432,6379,27017 proto tcp')
  expect(out).toContain('ufw allow in on docker0 to any port 20000:20999 proto tcp')
  expect(out).toContain('ufw allow 80,443,5432/tcp')
  // branch networks are user-defined bridges, not docker0: the pool itself is allowed too
  expect(out).toContain('ufw allow from 10.100.0.0/14 to any port 443,5432,6379,27017 proto tcp')
  expect(out).toContain('firewall-cmd --permanent --zone=docker --add-port=443/tcp --add-port=5432/tcp --add-port=6379/tcp --add-port=27017/tcp --add-port=20000-20999/tcp')
  expect(out).toContain('firewall-cmd --permanent --zone=public --add-port=80/tcp --add-port=443/tcp --add-port=5432/tcp')
  expect(out).toContain('firewall-cmd --reload')
  expect(script).toMatch(/ufw status 2>\/dev\/null \| grep -q '\^Status: active'/)
  expect(script).toMatch(/firewall-cmd --state/)
})

test('the run path: ports 80/443/5432 refused, 6379/3306/27017 warned, readiness on /healthz, the final lines', () => {
  expect(script).toContain('for _p in 80 443 5432; do')
  expect(script).toContain('for _p in 6379 3306 27017; do')
  expect(script).toContain('curl -fsSL https://get.docker.com | sh')
  expect(script).toContain('docker compose version')
  expect(script).toContain('up -d --remove-orphans')
  expect(script).toMatch(/"http:\/\/127\.0\.0\.1:\$PORT\/healthz"/)
  for (const line of [
    "log 'InstaCloud is running.'",
    'log "  Setup:    https://console.$DOMAIN/setup"',
    'log "  API:      https://api.$DOMAIN"',
    'log "  CLI:      insta login --api-key <token from the setup page> --api-url https://api.$DOMAIN"',
    'log "  Config $CFG   Data $DATA   Reflinks: $REFLINK"',
    "log 'Re-run this script to upgrade (add --version vX.Y.Z to pin).'",
  ]) expect(script).toContain(line)
  // --tls internal: the edge's root is copied where curl --cacert, PGSSLROOTCERT and NODE_EXTRA_CA_CERTS can use it
  expect(script).toContain('caddy/data/caddy/pki/authorities/local/root.crt')
  expect(script).toContain('"$DATA/edge/ca.pem"')
})

test('Dockerfile, .dockerignore, package.json and the workflows agree with the installer', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
  expect(dockerfile).toContain('INSTA_OSS_MODE=server')
  expect(dockerfile).toContain('INSTA_OSS_TEMPLATES_DIR=/app/templates')
  expect(dockerfile).toContain('INSTA_OSS_UI_DIST=/app/ui/dist')
  expect(dockerfile).toContain('COPY templates ./templates')
  expect(dockerfile).toContain('COPY --from=ui /app/ui/dist ./ui/dist')
  expect(dockerfile).toContain('COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker')
  expect(dockerfile).toContain('CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/main.ts"]')
  expect(dockerfile).toMatch(/^ARG NODE_IMAGE=node:22\.\d+\.\d+-bookworm-slim$/m)   // exact multi-arch pins
  expect(dockerfile).toMatch(/^FROM docker:28\.\d+\.\d+-cli AS dockercli$/m)
  expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*headers:\{host:'api\.'/)               // the router dispatches by Host (decision 4)
  const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8').split('\n')
  for (const p of ['node_modules', 'ui/node_modules', 'ui/dist', 'templates/node_modules', '.git', 'test', 'docs', 'plans']) expect(ignore).toContain(p)
  // tsx is the runtime inside the image, so it is a dependency, not a dev one
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string; scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> }
  expect(pkg.dependencies.tsx).toBeDefined()
  expect(pkg.devDependencies.tsx).toBeUndefined()
  expect(pkg.scripts.start).toBe('tsx src/main.ts')
  expect(pkg.scripts['build:image']).toContain('docker build')
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/)                                        // release source of truth
  const release = readFileSync(join(ROOT, '.github', 'workflows', 'release-image.yml'), 'utf8')
  expect(release).toContain("tags: ['v*']")
  expect(release).toContain('images: ghcr.io/insforge/instacloud')
  expect(release).toContain('platforms: linux/amd64,linux/arm64')
  expect(release).toContain('require(\'./package.json\').version')                      // tag must equal v<package.json version>
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const tail = ci.slice(ci.indexOf('# ---- WP6 ----'))
  expect(tail).toContain('shellcheck -s sh install.sh')
  expect(tail).toContain('docker build --build-arg VERSION=ci -t instacloud:ci .')
})
