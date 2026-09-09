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

// ---- region WP2 (router) ----
/** Which managed types route by TLS SNI on the shared server-mode lane (redis 6379, mongo 27017).
 *  MySQL greets first and has no SNI, so it gets a plaintext per-service port (decision 38). Kept as
 *  its own map (the catalog type above is not this region's to extend). */
export const MANAGED_SNI: Record<ManagedDbType, boolean> = { redis: true, mysql: false, mongodb: true }

/** The credential bundle against a LANE address instead of the container: same keys as
 *  `MANAGED_DB[type].bundle`, host and port swapped, and the TLS flag folded into the URL
 *  (`rediss://`, mongo `&tls=true`) when the lane terminates TLS (contract 00 section 10). */
export function laneBundle(type: ManagedDbType, host: string, port: number, password: string, tls: boolean): Record<string, string> {
  const pw = encodeURIComponent(password)
  const portStr = String(port)
  if (type === 'redis') {
    return {
      REDIS_URL: `${tls ? 'rediss' : 'redis'}://default:${pw}@${host}:${portStr}/0`,
      REDIS_HOST: host, REDIS_PORT: portStr, REDIS_USERNAME: 'default', REDIS_PASSWORD: password,
    }
  }
  if (type === 'mysql') {
    return {
      MYSQL_URL: `mysql://insta:${pw}@${host}:${portStr}/app`,
      MYSQL_HOST: host, MYSQL_PORT: portStr, MYSQL_DATABASE: 'app', MYSQL_USERNAME: 'insta', MYSQL_PASSWORD: password,
    }
  }
  return {
    MONGODB_URL: `mongodb://root:${pw}@${host}:${portStr}/admin?authSource=admin${tls ? '&tls=true' : ''}`,
    MONGODB_HOST: host, MONGODB_PORT: portStr, MONGODB_DATABASE: 'admin', MONGODB_USERNAME: 'root', MONGODB_PASSWORD: password,
  }
}
// ---- end region WP2 ----
// ---- region WP4 (data dir) ----
/** Where each managed image keeps its state, and the sub-directory of `md/<ref>/<prefix>-<dataId>/`
 *  that bind-mounts onto it (contract 00 section 12). One entry per path the image writes: mongo
 *  keeps its config server separate. A missing bind source makes `--mount type=bind` fail, so the
 *  engine creates every sub-directory before the container starts. */
export const MANAGED_DB_DATA_PATHS: Record<ManagedDbType, ReadonlyArray<{ containerPath: string; sub: string }>> = {
  redis: [{ containerPath: '/data', sub: 'data' }],
  mysql: [{ containerPath: '/var/lib/mysql', sub: 'mysql' }],
  mongodb: [{ containerPath: '/data/db', sub: 'db' }, { containerPath: '/data/configdb', sub: 'configdb' }],
}
export const dataPaths = (type: ManagedDbType): ReadonlyArray<{ containerPath: string; sub: string }> =>
  MANAGED_DB_DATA_PATHS[type]
// ---- end region WP4 ----
// ---- region WP5 (templates/parity) ----
// Naming helpers shared by every package (contract 00 section 7). Handles are READ from state when a
// row carries them (databases[id].container, buckets[id].bucket) and derived here only at provision.
/** Postgres container for one database service on a branch: `io-<ref>-pg-<name>`. */
export const pgContainerName = (ref: string, name: string): string => `io-${ref}-pg-${name}`
/** Bucket for one storage service on a branch: `io-<ref>-<name>` (legacy single bucket: `io-<ref>`). */
export const bucketName = (ref: string, name: string): string => `io-${ref}-${name}`
/** App container for one compute group on a branch: `io-<ref>-app-<group>`. */
export const appContainerName = (ref: string, group: string): string => `io-${ref}-app-${group}`
// WP5 adds: parseServiceId (strips the branch qualifier), pgServiceId, storageServiceId, CANONICAL_KEYS
// ---- end region WP5 ----

/** Resolve a managed service id (rd-* | my-* | mo-*) to its type + name, or null. */
export function parseManagedServiceId(sid: string): { type: ManagedDbType; name: string } | null {
  for (const type of MANAGED_DB_TYPES) {
    const p = `${MANAGED_DB[type].idPrefix}-`
    if (sid.startsWith(p) && sid.length > p.length) return { type, name: sid.slice(p.length) }
  }
  return null
}
