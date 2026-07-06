import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, relTime } from '../api'
import { usePoll } from '../hooks'
import { Button, ErrorNote } from '../components/ui'

export function Approvals() {
  const { projectId } = useParams() as { projectId: string }
  const { data: approvals, reload } = usePoll(() => api.approvals(projectId), [projectId], 3000)
  const [error, setError] = useState<string>()

  const decide = async (id: string, verdict: 'approve' | 'deny', always = false) => {
    setError(undefined)
    const r = await api.decide(projectId, id, verdict, always)
    if (r.kind === 'error') return setError(r.error)
    reload()
  }

  const pending = (approvals ?? []).filter((a) => a.status === 'pending')
  const decided = (approvals ?? []).filter((a) => a.status !== 'pending').slice(-10).reverse()

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <h1 className="mb-2 text-3xl font-bold text-neutral-900">Approvals</h1>
      <p className="mb-8 text-sm text-neutral-500">
        Actions your policy gates behind a human. Grants are one-shot: the requester retries and consumes it.
      </p>

      {pending.length === 0 && (
        <p className="rounded-xl border border-dashed border-neutral-200 px-4 py-8 text-center text-sm text-neutral-400">
          Nothing pending — gated actions will queue here.
        </p>
      )}
      <div className="space-y-2">
        {pending.map((a) => (
          <div key={a.id} className="flex items-center rounded-xl border border-amber-200 bg-amber-50/50 px-4 py-3">
            <div>
              <code className="font-mono text-sm font-medium text-neutral-800">{a.action}</code>
              <p className="text-xs text-neutral-500">requested {relTime(a.requested_at)}</p>
            </div>
            <div className="ml-auto flex gap-2">
              <Button kind="danger" onClick={() => decide(a.id, 'deny')}>Deny</Button>
              <Button kind="ghost" onClick={() => decide(a.id, 'approve', true)}>Grant always</Button>
              <Button onClick={() => decide(a.id, 'approve')}>Grant once</Button>
            </div>
          </div>
        ))}
      </div>
      <ErrorNote error={error} />

      {decided.length > 0 && (
        <>
          <h2 className="mb-2 mt-10 text-sm font-semibold text-neutral-500">Recent decisions</h2>
          <div className="space-y-1">
            {decided.map((a) => (
              <div key={a.id} className="flex items-center px-4 py-1.5 text-sm text-neutral-500">
                <code className="font-mono text-[13px]">{a.action}</code>
                <span className={`ml-3 text-xs ${a.status === 'denied' ? 'text-red-500' : 'text-green-600'}`}>{a.status}</span>
                <span className="ml-auto text-xs">{relTime(a.decided_at ?? a.requested_at)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
