import { useState } from 'react'
import { useParams } from 'react-router-dom'
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
    <div className="mx-auto max-w-4xl px-8 py-10">
      <h1 className="mb-8 text-3xl font-bold text-neutral-900">Settings</h1>

      <h2 className="mb-1 text-sm font-semibold text-neutral-700">Governance policy</h2>
      <p className="mb-3 text-xs text-neutral-500">
        Per-action gates, enforced by the daemon for every caller — CLI, agent, or this dashboard.
      </p>
      <div className="overflow-hidden rounded-xl border border-neutral-200">
        {Object.entries(policy ?? {}).map(([action, decision], i) => (
          <div key={action} className={`flex items-center px-4 py-2.5 ${i > 0 ? 'border-t border-neutral-100' : ''}`}>
            <code className="w-44 font-mono text-[13px] text-neutral-800">{action}</code>
            <div className="flex gap-1">
              {DECISIONS.map((d) => (
                <button key={d} onClick={() => set(action, d)} title={HINT[d]}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium ${decision === d
                    ? d === 'deny' ? 'bg-red-100 text-red-700' : d === 'approve' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'
                    : 'text-neutral-400 hover:bg-neutral-100'}`}>
                  {d}
                </button>
              ))}
            </div>
            <span className="ml-auto text-xs text-neutral-400">{HINT[decision as Decision]}</span>
          </div>
        ))}
      </div>
      <ErrorNote error={error} />

      <h2 className="mb-3 mt-10 text-sm font-semibold text-neutral-700">Recent events</h2>
      <div className="space-y-1">
        {(events ?? []).slice().reverse().map((e) => (
          <div key={e.id} className="flex items-center px-1 py-1 text-sm">
            <span className={`w-20 text-[11px] uppercase tracking-wide ${e.source === 'govern' ? 'text-amber-600' : e.source === 'agent' ? 'text-blue-500' : 'text-neutral-400'}`}>{e.source}</span>
            <code className="font-mono text-[13px] text-neutral-700">{e.kind}</code>
            {e.branch && <span className="ml-2 text-xs text-neutral-400">⑂ {e.branch}</span>}
            <span className="ml-auto text-xs text-neutral-400">{relTime(e.created_at)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
