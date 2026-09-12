// Container instance names, as logs and metrics report them, reduced to something readable.
//
// There is deliberately no "does this label belong to service X" helper any more. There was one,
// and it could not be made correct: instanceLabel reduces every container ending in `-pg` to
// "postgres", so a postgres service actually NAMED "pg" was indistinguishable from the branch's
// default database and had its own lines dropped. Scoping belongs at the daemon, which both the
// logs and metrics routes support with `?group=`, and which truncates AFTER selecting the
// container rather than before.

/** `io-demo-main-app-worker` -> `worker`; the branch's default database container -> `postgres`.
 *  Everything else (the extra database containers) is returned unchanged. Used only to label a
 *  line or a chart series, never to decide which lines belong to whom. */
export function instanceLabel(instance?: string): string {
  if (!instance) return ''
  if (instance.endsWith('-pg')) return 'postgres'
  const m = /-app-(.+)$/.exec(instance)
  return m ? m[1] : instance
}
