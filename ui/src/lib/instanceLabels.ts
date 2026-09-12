// Container instance names, as logs and metrics report them, reduced to the service they belong
// to. Lives here rather than beside the Logs page because Usage needs the same rules (it had its
// own copy of instanceLabel) and because the matching has a sharp edge worth testing directly.

/** `io-demo-main-app-worker` -> `worker`; the branch's default database container -> `postgres`.
 *  Everything else (the extra database containers) is returned unchanged. */
export function instanceLabel(instance?: string): string {
  if (!instance) return ''
  if (instance.endsWith('-pg')) return 'postgres'
  const m = /-app-(.+)$/.exec(instance)
  return m ? m[1] : instance
}

/** manageddb.ts: pgContainerName uses `pg`, managedContainerName uses each type's idPrefix. */
const DB_CONTAINER_PREFIXES = ['pg', 'rd', 'my', 'mo']

/** Whether a container label belongs to the service named `name`.
 *
 *  Only database containers reach here with a raw name: instanceLabel has already reduced a
 *  compute container to its exact group. So the raw case matches on the container's OWN prefix
 *  (`io-<ref>-<prefix>-<name>`) rather than a bare "ends with -<name>", which also matched compute
 *  groups whose names are suffixes of one another and pulled `worker-api` into `api`. */
export function labelMatches(label: string, name: string): boolean {
  if (label === name) return true
  if (name === 'db' && label === 'postgres') return true
  return DB_CONTAINER_PREFIXES.some((p) => label.endsWith(`-${p}-${name}`))
}
