import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { Button, Input } from '@insforge/ui'
import { Plus, X } from 'lucide-react'
import { api, relTime } from '../api'
import { usePoll } from '../hooks'
import { ErrorNote, Modal, StatusDot, TypeIcon } from '../components/ui'
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
    <Modal
      title="Add service"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit}>Add</Button>
        </>
      }
    >
      <label className="text-xs font-medium text-muted-foreground">Compute group name</label>
      <Input
        autoFocus value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="worker" className="mt-1"
      />
      <p className="mt-3 text-xs text-muted-foreground">
        Postgres and storage are the fixed local pair — one of each per project, provisioned automatically.
        A compute group materializes on its first <code className="font-mono">insta deploy --group</code>.
      </p>
      <ErrorNote error={error} />
    </Modal>
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
    <div className="mx-auto flex w-full max-w-[64rem] flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[32px] leading-12 font-bold">Service</h1>
        <Button variant="primary" className="gap-1.5" onClick={() => setAdding(true)}>
          <Plus className="size-4" />
          Add Service
        </Button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="px-4 py-3 text-left text-sm font-normal text-muted-foreground">Service</th>
              <th className="px-4 py-3 text-left text-sm font-normal text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left text-sm font-normal text-muted-foreground">Endpoint</th>
              <th className="px-4 py-3 text-left text-sm font-normal text-muted-foreground">Updated</th>
              <th className="w-12" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {(services ?? []).map((s) => (
              <tr key={s.id} className="group border-b border-border last:border-b-0">
                <td className="px-4 py-2">
                  <div className="flex items-center gap-3">
                    <TypeIcon type={s.type} />
                    <span className="text-sm font-medium capitalize">
                      {s.type === 'postgres' ? 'Postgres' : s.type === 'storage' ? 'Storage' : s.name}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-2"><StatusDot runtime={s.runtime} /></td>
                <td className="max-w-48 truncate px-4 py-2 font-mono text-xs text-muted-foreground" title={s.endpoint}>
                  {s.endpoint ?? '—'}
                </td>
                <td className="px-4 py-2 text-sm text-muted-foreground">{relTime(s.updated_at)}</td>
                <td className="px-2 py-2 text-right">
                  {s.type === 'compute' && (
                    <Button variant="ghost" size="icon-sm" onClick={() => remove(s.id)}
                      title={`remove ${s.name}`} className="invisible group-hover:visible">
                      <X className="size-4 text-muted-foreground" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {services && services.length === 2 && (
        <p className="text-center text-sm text-muted-foreground">
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
