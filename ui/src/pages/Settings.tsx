// Project settings in the console's layout (a title band, then settings cards with label-left
// rows). Self-host divergence: the console's settings panel holds the project name and delete; the
// daemon's holds its governance policy, which it enforces for every caller, and the recent events.

import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { cn } from '@insforge/ui'
import { GitBranch } from 'lucide-react'
import { api, relTime, type Decision } from '../api'
import { usePoll } from '../hooks'
import { SettingsCard, SettingsRow } from '../components/console/SettingsRow'
import { ErrorNote } from '../components/ui'

const DECISIONS: Decision[] = ['allow', 'approve', 'deny']
const HINT: Record<Decision, string> = {
  allow: 'Runs immediately.',
  approve: 'Queues for a human grant (202).',
  deny: 'Always rejected (403).',
}

function DecisionToggle({ value, onChange }: { value: Decision; onChange: (d: Decision) => void }) {
  return (
    <div className="grid w-fit grid-cols-3 border border-border bg-card">
      {DECISIONS.map((d) => (
        <button key={d} type="button" aria-pressed={value === d} title={HINT[d]} onClick={() => onChange(d)}
          className={cn('h-8 w-24 px-2 text-[13px] capitalize transition-colors',
            value === d
              ? d === 'deny' ? 'bg-destructive text-inverse' : d === 'approve' ? 'bg-warning text-inverse' : 'bg-success text-inverse'
              : 'text-muted-foreground hover:bg-alpha-4 hover:text-foreground')}>
          {d}
        </button>
      ))}
    </div>
  )
}

export function Settings() {
  const { projectId } = useParams() as { projectId: string }
  const { data: policy, reload } = usePoll(() => api.policy(projectId), [projectId])
  const { data: events } = usePoll(() => api.events(projectId, 20), [projectId])
  const [error, setError] = useState<string>()

  const set = async (action: string, decision: Decision) => {
    setError(undefined)
    const r = await api.setPolicy(projectId, action, decision)
    if (r.kind === 'error') return setError(r.error)
    reload()
  }

  return (
    <div className="-mx-8 -mt-8 flex w-auto flex-col gap-4">
      <div className="px-6">
        <div className="flex flex-col gap-1 py-4.5">
          <h1 className="text-[32px] leading-12 font-semibold">Settings</h1>
          <p className="text-[13px] text-muted-foreground">
            Per-action gates, enforced by the daemon for every caller: the CLI, an agent, or this dashboard.
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-4 px-6">
        <SettingsCard title="Governance Policy">
          {Object.entries(policy ?? {}).map(([action, decision]) => (
            <SettingsRow key={action} label={action} hint={HINT[decision as Decision]}>
              <DecisionToggle value={decision as Decision} onChange={(d) => { void set(action, d) }} />
            </SettingsRow>
          ))}
        </SettingsCard>
        <ErrorNote error={error} />

        <SettingsCard title="Recent Events">
          {(events ?? []).slice().reverse().map((e) => (
            <div key={e.id} className="flex items-center gap-3 py-1 text-sm">
              <span className={cn('w-20 text-[11px] tracking-wide uppercase',
                e.source === 'govern' ? 'text-warning' : e.source === 'agent' ? 'text-info' : 'text-muted-foreground')}>
                {e.source}
              </span>
              <code className="font-mono text-[13px]">{e.kind}</code>
              {e.branch && (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <GitBranch className="size-3" />
                  {e.branch}
                </span>
              )}
              <span className="ml-auto text-xs text-muted-foreground">{relTime(e.created_at)}</span>
            </div>
          ))}
        </SettingsCard>
      </div>
    </div>
  )
}
