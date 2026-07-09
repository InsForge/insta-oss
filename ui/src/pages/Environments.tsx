import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { usePoll } from '../hooks'
import { Button, Chip, Dialog, ErrorNote } from '../components/ui'
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
    <Dialog title="New environment" onClose={onClose}>
      <label className="text-xs font-medium text-neutral-500">Name</label>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="feature-x" className="mt-1 w-full rounded-md border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-green-500" />
      <label className="mt-3 block text-xs font-medium text-neutral-500">Clone from</label>
      <select value={source} onChange={(e) => setSource(e.target.value)}
        className="mt-1 w-full rounded-md border border-neutral-200 px-3 py-2 text-sm">
        {from.map((b) => <option key={b}>{b}</option>)}
      </select>
      <p className="mt-3 text-xs text-neutral-500">
        An environment is a full isolated clone: its own Postgres (data copied), its own bucket (objects copied),
        and a redeploy of every app — nothing it does touches the source environment
        (<code className="font-mono">insta branch create</code> on the CLI).
      </p>
      <ErrorNote error={error} />
      <div className="mt-5 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} disabled={busy}>{busy ? 'Cloning…' : 'Create environment'}</Button>
      </div>
    </Dialog>
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
    <div className="mx-auto max-w-4xl px-8 py-10">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-3xl font-bold text-neutral-900">Environments</h1>
        <Button onClick={() => setCreating(true)}>+ Add Environment</Button>
      </div>
      <div className="space-y-2">
        {(branches ?? []).map((b) => (
          <div key={b.id} className="group flex items-center rounded-xl border border-neutral-200 bg-neutral-50/60 px-4 py-3 hover:bg-neutral-50">
            <button onClick={() => nav(`/p/${projectId}/${b.name}/services`)}
              className="flex items-center gap-2 text-sm font-medium text-neutral-800 hover:underline">
              ⑂ {b.name}
            </button>
            <span className="ml-3">{b.is_default && <Chip>Prod</Chip>}</span>
            <span className="ml-auto mr-4 text-xs text-neutral-400">{b.status}</span>
            {!b.is_default && (
              <button onClick={() => del(b.id)} title="delete environment (full teardown of its containers)"
                className="invisible text-neutral-400 hover:text-red-600 group-hover:visible">✕</button>
            )}
          </div>
        ))}
      </div>
      <p className="mt-6 text-xs text-neutral-400">
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
