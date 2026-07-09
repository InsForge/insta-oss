import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Input } from '@insforge/ui'
import { GitBranch, Plus, X } from 'lucide-react'
import { api } from '../api'
import { usePoll } from '../hooks'
import { Chip, ErrorNote, Modal } from '../components/ui'
import { ApprovalPrompt, type PendingApproval } from '../components/ApprovalPrompt'

function NewEnvironmentDialog({ projectId, from, onClose, onDone }: {
  projectId: string; from: string[]; onClose: () => void; onDone: (name: string) => void
}) {
  const [name, setName] = useState('')
  const [source, setSource] = useState(from[0] ?? 'main')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async () => {
    if (!name.trim()) return setError('name required')
    setBusy(true)
    const r = await api.createBranch(projectId, name.trim(), source)
    setBusy(false)
    if (r.kind === 'error') return setError(r.error)
    if (r.kind === 'approval') return setError('environment creation gated — approve it from the Approvals page')
    onClose(); onDone(name.trim())
  }
  return (
    <Modal
      title="New environment"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>{busy ? 'Cloning…' : 'Create environment'}</Button>
        </>
      }
    >
      <label className="text-xs font-medium text-muted-foreground">Name</label>
      <Input
        autoFocus value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="feature-x" className="mt-1"
      />
      <label className="mt-3 block text-xs font-medium text-muted-foreground">Clone from</label>
      <select value={source} onChange={(e) => setSource(e.target.value)}
        className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm">
        {from.map((b) => <option key={b}>{b}</option>)}
      </select>
      <p className="mt-3 text-xs text-muted-foreground">
        An environment is a full isolated clone: its own Postgres (data copied), its own bucket (objects copied),
        and a redeploy of every app — nothing it does touches the source environment
        (<code className="font-mono">insta branch create</code> on the CLI).
      </p>
      <ErrorNote error={error} />
    </Modal>
  )
}

export function Environments() {
  const { projectId } = useParams() as { projectId: string }
  const nav = useNavigate()
  const { data: branches, reload } = usePoll(() => api.branches(projectId), [projectId])
  const [creating, setCreating] = useState(false)
  const [approval, setApproval] = useState<PendingApproval>(null)
  const [error, setError] = useState<string>()

  const del = async (branchId: string) => {
    setError(undefined)
    const r = await api.deleteBranch(projectId, branchId)
    if (r.kind === 'error') return setError(r.error)
    if (r.kind === 'approval') return setApproval({ ...r, retry: () => del(branchId) })
    reload()
  }

  return (
    <div className="mx-auto flex w-full max-w-[64rem] flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[32px] leading-12 font-bold">Environments</h1>
        <Button variant="primary" className="gap-1.5" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          Add Environment
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {(branches ?? []).map((b) => (
          <div key={b.id} className="group flex items-center border-b border-border px-4 py-3 last:border-b-0">
            <button onClick={() => nav(`/p/${projectId}/${b.name}/services`)}
              className="flex items-center gap-2 text-sm font-medium hover:underline">
              <GitBranch className="size-4 text-muted-foreground" />
              {b.name}
            </button>
            <span className="ml-3">{b.is_default && <Chip>Prod</Chip>}</span>
            <span className="ml-auto mr-4 text-xs text-muted-foreground">{b.status}</span>
            {!b.is_default && (
              <Button variant="ghost" size="icon-sm" onClick={() => del(b.id)}
                title="delete environment (full teardown of its containers)"
                className="invisible group-hover:visible">
                <X className="size-4 text-muted-foreground hover:text-destructive" />
              </Button>
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Environments never merge — promote by merging code in git, running migration files against the target
        environment, and redeploying it (see the insta skill's branching guide).
      </p>
      <ErrorNote error={error} />
      {creating && (
        <NewEnvironmentDialog projectId={projectId} from={(branches ?? []).map((b) => b.name)}
          onClose={() => setCreating(false)} onDone={(name) => nav(`/p/${projectId}/${name}/services`)} />
      )}
      <ApprovalPrompt projectId={projectId} pending={approval} onClose={() => setApproval(null)} />
    </div>
  )
}
