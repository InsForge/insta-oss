import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { cn } from '@insforge/ui'
import { GitBranch } from 'lucide-react'
import { api, relTime, type Decision } from '../api'
import { usePoll } from '../hooks'
import { ErrorNote } from '../components/ui'

const DECISIONS: Decision[] = ['allow', 'approve', 'deny']
const HINT: Record<Decision, string> = {
  allow: 'runs immediately',
  approve: 'queues for a human grant (202)',
  deny: 'always rejected (403)',
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
    <div className="mx-auto flex w-full max-w-[64rem] flex-col gap-4">
      <h1 className="text-[32px] leading-12 font-bold">Settings</h1>

      <div>
        <h2 className="text-sm font-semibold">Governance policy</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Per-action gates, enforced by the daemon for every caller — CLI, agent, or this dashboard.
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {Object.entries(policy ?? {}).map(([action, decision], i) => (
          <div key={action} className={cn('flex items-center px-4 py-2.5', i > 0 && 'border-t border-border')}>
            <code className="w-44 font-mono text-[13px]">{action}</code>
            <div className="flex gap-1">
              {DECISIONS.map((d) => (
                <button key={d} onClick={() => set(action, d)} title={HINT[d]}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    decision === d
                      ? d === 'deny' ? 'bg-destructive text-inverse'
                        : d === 'approve' ? 'bg-warning text-inverse'
                        : 'bg-success text-inverse'
                      : 'text-muted-foreground hover:bg-alpha-4 hover:text-foreground',
                  )}>
                  {d}
                </button>
              ))}
            </div>
            <span className="ml-auto text-xs text-muted-foreground">{HINT[decision as Decision]}</span>
          </div>
        ))}
      </div>
      <ErrorNote error={error} />

      <h2 className="mt-6 text-sm font-semibold">Recent events</h2>
      <div className="flex flex-col gap-1">
        {(events ?? []).slice().reverse().map((e) => (
          <div key={e.id} className="flex items-center px-1 py-1 text-sm">
            <span className={cn(
              'w-20 text-[11px] uppercase tracking-wide',
              e.source === 'govern' ? 'text-warning' : e.source === 'agent' ? 'text-info' : 'text-muted-foreground',
            )}>{e.source}</span>
            <code className="font-mono text-[13px]">{e.kind}</code>
            {e.branch && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                <GitBranch className="size-3" />
                {e.branch}
              </span>
            )}
            <span className="ml-auto text-xs text-muted-foreground">{relTime(e.created_at)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
