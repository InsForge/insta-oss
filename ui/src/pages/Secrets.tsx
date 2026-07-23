import { useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  Button, CopyButton, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, Input, cn,
} from '@insforge/ui'
import { EllipsisVertical, Eye, EyeOff, Plus } from 'lucide-react'
import { api } from '../api'
import { usePoll } from '../hooks'
import { ErrorNote, Modal } from '../components/ui'
import { ApprovalPrompt, type PendingApproval } from '../components/ApprovalPrompt'

/** Platform-minted credential names are managed and read-only — same set the daemon reserves. */
function isManaged(name: string): boolean {
  return name === 'DATABASE_URL' || name === 'BUCKET_NAME' || name.startsWith('AWS_') ||
    name.startsWith('DATABASE_URL_') || name.startsWith('BUCKET_NAME_')
}

/** Masked by default; reveal is per-row and resets when the row unmounts. */
function ValueCell({ value }: { value: string }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <div className="flex items-center gap-1">
      <span className={cn(
        'min-w-0 flex-1 truncate font-mono text-[13px]',
        !revealed && 'tracking-widest text-muted-foreground select-none',
      )}>
        {revealed ? value : '••••••••'}
      </span>
      <Button variant="ghost" size="icon-sm" aria-label={revealed ? 'Hide value' : 'Reveal value'}
        onClick={() => setRevealed(!revealed)}>
        {revealed ? <EyeOff className="size-4 text-muted-foreground" /> : <Eye className="size-4 text-muted-foreground" />}
      </Button>
      <CopyButton text={value} />
    </div>
  )
}

function SecretDialog({ projectId, branch, editing, onClose, onDone, onApproval }: {
  projectId: string; branch: string; editing: { name: string; value: string } | null
  onClose: () => void; onDone: () => void
  onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const [name, setName] = useState(editing?.name ?? '')
  const [value, setValue] = useState(editing?.value ?? '')
  const [scope, setScope] = useState<'env' | 'project'>('project')
  const [error, setError] = useState<string>()
  const submit = async () => {
    if (!name.trim() || !value) return setError('name and value are required')
    const r = await api.setSecret(projectId, name.trim(), value, scope === 'env' ? branch : undefined)
    if (r.kind === 'error') return setError(r.error)
    if (r.kind === 'approval') { onClose(); return onApproval({ ...r, retry: submit }) }
    onClose(); onDone()
  }
  return (
    <Modal
      title={editing ? 'Edit Secret' : 'Add Secret'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit}>{editing ? 'Save' : 'Add'}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Name</label>
          <Input autoFocus={!editing} disabled={!!editing} value={name}
            onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
            placeholder="API_KEY" className="mt-1 font-mono" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Value</label>
          <Input autoFocus={!!editing} value={value} onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()} className="mt-1 font-mono" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Scope</label>
          <div className="mt-1 flex items-center gap-0.5 self-start rounded-md border border-border p-0.5">
            {([['project', 'All environments'], ['env', `Only ${branch}`]] as const).map(([key, label]) => (
              <button key={key} type="button" onClick={() => setScope(key)}
                className={cn('rounded px-3 py-1 text-sm transition-colors',
                  scope === key ? 'bg-alpha-8 font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <ErrorNote error={error} />
      </div>
    </Modal>
  )
}

/** The environment's secret bundle: managed service credentials read-only, user secrets editable. */
export function Secrets() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  const { data, error, reload } = usePoll(() => api.secretsBundle(projectId, branch), [projectId, branch], 15000)
  const [dialog, setDialog] = useState<{ editing: { name: string; value: string } | null } | null>(null)
  const [approval, setApproval] = useState<PendingApproval>(null)
  const [actionError, setActionError] = useState<string>()

  const remove = async (name: string) => {
    setActionError(undefined)
    // project-wide first; a branch-scoped override needs the branch — try both
    const r = await api.unsetSecret(projectId, name)
    if (r.kind === 'approval') return setApproval({ ...r, retry: () => remove(name) })
    if (r.kind === 'error') return setActionError(r.error)
    await api.unsetSecret(projectId, name, branch)
    reload()
  }

  const rows = Object.entries(data ?? {}).sort(([a], [b]) => {
    const ma = isManaged(a) ? 0 : 1, mb = isManaged(b) ? 0 : 1
    return ma !== mb ? ma - mb : a.localeCompare(b)
  })

  return (
    <div className="mx-auto flex w-full max-w-[64rem] flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-[32px] leading-12 font-bold">Secrets</h1>
          <p className="text-sm text-muted-foreground">
            Environment variables for <span className="font-medium">{branch}</span> — managed service
            credentials plus your user-defined secrets.
          </p>
        </div>
        <Button variant="primary" className="gap-1.5" onClick={() => setDialog({ editing: null })}>
          <Plus className="size-4" />
          Add Secret
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full table-fixed">
          <thead>
            <tr className="border-b border-border">
              <th className="w-72 px-4 py-3 text-left text-[13px] font-normal text-muted-foreground">Name</th>
              <th className="px-4 py-3 text-left text-[13px] font-normal text-muted-foreground">Value</th>
              <th className="w-28 px-4 py-3 text-left text-[13px] font-normal text-muted-foreground">Source</th>
              <th className="w-12" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {error ? error.message : 'No secrets in this environment yet.'}
                </td>
              </tr>
            ) : (
              rows.map(([name, value]) => (
                <tr key={name} className="border-b border-border last:border-b-0">
                  <td className="truncate px-4 py-2.5 font-mono text-[13px]">{name}</td>
                  <td className="px-4 py-2.5"><ValueCell value={value} /></td>
                  <td className="px-4 py-2.5">
                    <span className={cn('rounded-md px-1.5 py-0.5 text-xs font-medium',
                      isManaged(name) ? 'bg-alpha-8 text-muted-foreground' : 'bg-success/10 text-success')}>
                      {isManaged(name) ? 'Managed' : 'User'}
                    </span>
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    {!isManaged(name) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`}>
                            <EllipsisVertical className="size-4 text-muted-foreground" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setDialog({ editing: { name, value } })}>
                            Edit Secret
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-destructive focus:text-destructive"
                            onSelect={() => remove(name)}>
                            Delete Secret
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <ErrorNote error={actionError} />

      {dialog && (
        <SecretDialog projectId={projectId} branch={branch} editing={dialog.editing}
          onClose={() => setDialog(null)} onDone={reload} onApproval={setApproval} />
      )}
      <ApprovalPrompt projectId={projectId} pending={approval} onClose={() => setApproval(null)} />
    </div>
  )
}
