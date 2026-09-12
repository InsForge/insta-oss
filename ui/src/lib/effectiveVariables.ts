// Which variable names a service's container actually receives, and which scope each one comes
// from. A container receives ONE value per name, so this is a map keyed by name, not a list: the
// daemon overwrites in a fixed order and the Secrets dialog deliberately allows the same name at
// both project and environment scope, so a project `API_KEY` with an environment override is one
// variable whose source is the environment, never two rows with contradictory sources.

import type { SecretTree } from '../api'

export type EffectiveVariable = { name: string; source: string }

type Branch = SecretTree['branches'][number]

/** The order engine.envFor merges in, lowest precedence first:
 *    minted credentials -> project-wide -> this branch's unbound secrets -> bound to THIS group.
 *  A non-compute service shows only what it mints and what is bound to it; a secret bound to
 *  another compute group never reaches this one. */
export function effectiveVariables(
  tree: SecretTree | undefined,
  branch: Branch | undefined,
  service: { type: string; name: string },
): EffectiveVariable[] {
  const effective = new Map<string, string>()
  if (!tree || !branch) return []
  if (service.type === 'compute') {
    for (const s of branch.services) {
      if (s.type === 'compute') continue
      for (const n of s.minted) effective.set(n, s.name)
    }
    for (const n of tree.projectWide) effective.set(n, 'Project')
    for (const n of branch.unbound) effective.set(n, 'Environment')
    const own = branch.services.find((s) => s.type === 'compute' && s.name === service.name)
    for (const n of own?.secrets ?? []) effective.set(n, 'This service')
  } else {
    const own = branch.services.find((s) => s.type === service.type && s.name === service.name)
    for (const n of own?.secrets ?? []) effective.set(n, service.name)
  }
  return Array.from(effective, ([name, source]) => ({ name, source }))
}
