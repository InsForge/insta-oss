import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, relTime, type Service } from '../api'
import { usePoll } from '../hooks'
import { Button, Dialog, ErrorNote, StatusDot, TypeIcon } from '../components/ui'
import { ApprovalPrompt, type PendingApproval } from '../components/ApprovalPrompt'

function AddDialog({ projectId, onClose, onDone, onApproval }: {
  projectId: string; onClose: () => void; onDone: () => void
  onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string>()
  const submit = async () => {
    if (!name.trim()) return setError('name required')
    const r = await api.addComputeService(projectId, name.trim())
    if (r.kind === 'error') return setError(r.error)
    if (r.kind === 'approval') { onClose(); return onApproval({ ...r, retry: submit }) }
    onClose(); onDone()
  }
  return (
    <Dialog title="Add service" onClose={onClose}>
      <label className="text-xs font-medium text-neutral-500">Compute group name</label>
      <input
        autoFocus value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="worker" className="mt-1 w-full rounded-md border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-green-500"
      />
      <p className="mt-3 text-xs text-neutral-500">
        Postgres and storage are the fixed local pair — one of each per project, provisioned automatically.
        A compute group materializes on its first <code className="font-mono">insta deploy --group</code>.
      </p>
      <ErrorNote error={error} />
      <div className="mt-5 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit}>+ Add</Button>
      </div>
    </Dialog>
  )
}

function Row({ s, onRemove }: { s: Service; onRemove?: () => void }) {
  return (
    <div className="group flex items-center rounded-xl border border-neutral-200 bg-neutral-50/60 px-4 py-3 hover:bg-neutral-50">
      <div className="flex w-2/5 items-center gap-3">
        <TypeIcon type={s.type} />
        <span className="text-sm font-medium capitalize text-neutral-800">
          {s.type === 'postgres' ? 'Postgres' : s.type === 'storage' ? 'Storage' : s.name}
        </span>
      </div>
      <div className="w-1/5"><StatusDot runtime={s.runtime} /></div>
      <div className="w-1/4 truncate font-mono text-xs text-neutral-600" title={s.endpoint}>{s.endpoint ?? '—'}</div>
      <div className="flex flex-1 items-center justify-end gap-3 text-sm text-neutral-500">
        {relTime(s.updated_at)}
        {onRemove && (
          <button onClick={onRemove} title={`remove ${s.name}`}
            className="invisible text-neutral-400 hover:text-red-600 group-hover:visible">✕</button>
        )}
      </div>
    </div>
  )
}

export function Services() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  const { data: services, error, reload } = usePoll(() => api.services(projectId, branch), [projectId, branch])
  const [adding, setAdding] = useState(false)
  const [approval, setApproval] = useState<PendingApproval>(null)
  const [actionError, setActionError] = useState<string>()

  const remove = async (sid: string) => {
    setActionError(undefined)
    const r = await api.removeService(projectId, sid)
    if (r.kind === 'error') return setActionError(r.error)
    if (r.kind === 'approval') return setApproval({ ...r, retry: () => remove(sid) })
    reload()
  }

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-3xl font-bold text-neutral-900">Service</h1>
        <Button onClick={() => setAdding(true)}>+ Add</Button>
      </div>
      <div className="mb-2 flex px-4 text-xs font-medium text-neutral-500">
        <span className="w-2/5">Service</span>
        <span className="w-1/5">Status</span>
        <span className="w-1/4">Endpoint</span>
        <span className="flex-1 text-right">Updated</span>
      </div>
      <div className="space-y-2">
        {(services ?? []).map((s) => (
          <Row key={s.id} s={s} onRemove={s.type === 'compute' ? () => remove(s.id) : undefined} />
        ))}
      </div>
      {services && services.length === 2 && (
        <p className="mt-6 text-center text-sm text-neutral-400">
          No compute yet — deploy with <code className="font-mono">insta deploy --image &lt;img&gt; --port &lt;p&gt;</code> or add a group.
        </p>
      )}
      <ErrorNote error={actionError ?? error} />
      {adding && (
        <AddDialog projectId={projectId} onClose={() => setAdding(false)} onDone={reload}
          onApproval={setApproval} />
      )}
      <ApprovalPrompt projectId={projectId} pending={approval} onClose={() => setApproval(null)} />
    </div>
  )
}
