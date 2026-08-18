// Managed-database catalog + the seam's naming contract for them — pure data, no docker. Mirrors
// the platform (services.ts MANAGED_FLY_DATABASES + secretNames.ts CANONICAL_KEYS): same images,
// ports, env, bundle keys and suffix rule, so `.env` written against either target is identical
// modulo the host. The host is the LOCAL container name (the cloud's is `<flyApp>.internal`) —
// both resolve only from inside the branch's private network.
import { randomBytes } from 'node:crypto'
import type { ManagedDbType } from './types'

export const MANAGED_DB_TYPES: readonly ManagedDbType[] = ['redis', 'mysql', 'mongodb']
export const isManagedDbType = (s: string): s is ManagedDbType => (MANAGED_DB_TYPES as readonly string[]).includes(s)

type ManagedDbConfig = {
  idPrefix: string // stable oss service-id prefix (pg-db / st-store / cp-<group> convention)
  image: string
  port: number
  volumeGib: number // fixed 1Gi on the cloud; advisory locally (reported, not enforced)
  cmd?: string[]
  env(password: string): Record<string, string>
  bundle(host: string, password: string): Record<string, string>
}

export const MANAGED_DB: Record<ManagedDbType, ManagedDbConfig> = {
  redis: {
    idPrefix: 'rd',
    image: 'valkey/valkey:7',
    port: 6379,
    volumeGib: 1,
    cmd: [
      'sh',
      '-c',
      'exec valkey-server --appendonly yes --dir /data --requirepass "$REDIS_PASSWORD" --bind 0.0.0.0 --protected-mode no',
    ],
    env: (password) => ({ REDIS_PASSWORD: password }),
    bundle: (host, password) => ({
      REDIS_URL: `redis://default:${encodeURIComponent(password)}@${host}:6379/0`,
      REDIS_HOST: host,
      REDIS_PORT: '6379',
      REDIS_USERNAME: 'default',
      REDIS_PASSWORD: password,
    }),
  },
  mysql: {
    idPrefix: 'my',
    image: 'mysql:8.4',
    port: 3306,
    volumeGib: 1,
    env: (password) => ({
      MYSQL_DATABASE: 'app',
      MYSQL_USER: 'insta',
      MYSQL_PASSWORD: password,
      // the image refuses to start without a root password; like the cloud, it is random and
      // never surfaced — apps use the `insta` user
      MYSQL_ROOT_PASSWORD: randomBytes(32).toString('base64url'),
    }),
    bundle: (host, password) => ({
      MYSQL_URL: `mysql://insta:${encodeURIComponent(password)}@${host}:3306/app`,
      MYSQL_HOST: host,
      MYSQL_PORT: '3306',
      MYSQL_DATABASE: 'app',
      MYSQL_USERNAME: 'insta',
      MYSQL_PASSWORD: password,
    }),
  },
  mongodb: {
    idPrefix: 'mo',
    image: 'mongo:7',
    port: 27017,
    volumeGib: 1,
    env: (password) => ({
      MONGO_INITDB_ROOT_USERNAME: 'root',
      MONGO_INITDB_ROOT_PASSWORD: password,
    }),
    bundle: (host, password) => ({
      MONGODB_URL: `mongodb://root:${encodeURIComponent(password)}@${host}:27017/admin?authSource=admin`,
      MONGODB_HOST: host,
      MONGODB_PORT: '27017',
      MONGODB_DATABASE: 'admin',
      MONGODB_USERNAME: 'root',
      MONGODB_PASSWORD: password,
    }),
  },
}

// The canonical (unsuffixed) key set per type — reserved from user secrets, aliased at read time
// for the oldest service of each type (platform secretNames.ts CANONICAL_KEYS).
export const CANONICAL_MANAGED_KEYS: ReadonlySet<string> = new Set(
  MANAGED_DB_TYPES.flatMap((t) => Object.keys(MANAGED_DB[t].bundle('h', 'p'))),
)

// Service names are lower-kebab, so this is injective (platform secretNames.ts envSuffix).
export const envSuffix = (serviceName: string): string => serviceName.replace(/-/g, '_').toUpperCase()

export function suffixBundle(bundle: Record<string, string>, serviceName: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(bundle)) out[`${k}_${envSuffix(serviceName)}`] = v
  return out
}

export const managedServiceId = (type: ManagedDbType, name: string): string => `${MANAGED_DB[type].idPrefix}-${name}`
export const managedContainerName = (ref: string, type: ManagedDbType, name: string): string =>
  `io-${ref}-${MANAGED_DB[type].idPrefix}-${name}`

/** Resolve a managed service id (rd-* | my-* | mo-*) to its type + name, or null. */
export function parseManagedServiceId(sid: string): { type: ManagedDbType; name: string } | null {
  for (const type of MANAGED_DB_TYPES) {
    const p = `${MANAGED_DB[type].idPrefix}-`
    if (sid.startsWith(p) && sid.length > p.length) return { type, name: sid.slice(p.length) }
  }
  return null
}
