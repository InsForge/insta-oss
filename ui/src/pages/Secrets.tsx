import { useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, Input, cn,
} from '@insforge/ui'
import { EllipsisVertical, Plus } from 'lucide-react'
import { api, type SecretTree } from '../api'
import { usePoll } from '../hooks'
import { ErrorNote, Modal } from '../components/ui'
import { ApprovalPrompt, type PendingApproval } from '../components/ApprovalPrompt'

/** Platform-minted credential names the daemon reserves — shown read-only, badged Managed. */
function isManaged(name: string): boolean {
  return name === 'DATABASE_URL' || name === 'BUCKET_NAME' || name.startsWith('AWS_') ||
    name.startsWith('DATABASE_URL_') || name.startsWith('BUCKET_NAME_')
}

type Scope = 'project' | 'branch'
type Row = { name: string; managed: boolean; scope: Scope; source: string }

/** Flatten the names-only tree into display rows for the current environment. A name is Managed
 *  when it's a minted credential; user secrets are project-wide or scoped to this environment. */
function rowsFor(tree: SecretTree, branch: string): Row[] {
  const b = tree.branches.find((x) => x.name === branch)
  const rows: Row[] = []
  for (const name of tree.projectWide) rows.push({ name, managed: false, scope: 'project', source: 'All environments' })
  if (b) {
    for (const svc of b.services) {
      for (const name of svc.secrets) {
        if (isManaged(name)) rows.push({ name, managed: true, scope: 'branch', source: `${svc.type}/${svc.name}` })
        else rows.push({ name, managed: false, scope: 'branch', source: `${svc.type}/${svc.name}` })
      }
    }
    for (const name of b.unbound) rows.push({ name, managed: false, scope: 'branch', source: branch })
  }
  return rows.sort((x, y) => (x.managed === y.managed ? x.name.localeCompare(y.name) : x.managed ? -1 : 1))
}

function SecretDialog({ projectId, branch, editing, onClose, onDone, onApproval }: {
  projectId: string; branch: string; editing: Row | null
  onClose: () => void; onDone: () => void
  onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const [name, setName] = useState(editing?.name ?? '')
  const [value, setValue] = useState('')
  const [scope, setScope] = useState<Scope>(editing?.scope ?? 'project')
  const [error, setError] = useState<string>()
  const submit = async () => {
    if (!name.trim() || !value) return setError('name and value are required')
    const r = await api.setSecret(projectId, name.trim(), value, scope === 'branch' ? branch : undefined)
    if (r.kind === 'error') return setError(r.error)
    if (r.kind === 'approval') { onClose(); return onApproval({ ...r, retry: submit }) }
    onClose(); onDone()
  }
  return (
    <Modal
      title={editing ? 'Update Secret' : 'Add Secret'}
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
          <Input autoFocus={!!editing} type="password" value={value} onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder={editing ? 'new value' : ''}
            className="mt-1 font-mono" />
          {editing && <p className="mt-1 text-xs text-muted-foreground">The current value is never shown — enter a new one to overwrite it.</p>}
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Scope</label>
          <div className="mt-1 flex items-center gap-0.5 self-start rounded-md border border-border p-0.5">
            {([['project', 'All environments'], ['branch', `Only ${branch}`]] as const).map(([key, label]) => (
              <button key={key} type="button" onClick={() => setScope(key)} disabled={!!editing}
                className={cn('rounded px-3 py-1 text-sm transition-colors disabled:opacity-60',
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

/** The environment's secret inventory — NAMES ONLY (values stay behind `insta secrets`, which is
 *  secrets.read-gated). Managed service credentials are read-only; user secrets are editable. */
export function Secrets() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  // 30s poll: /secrets/tree is names-only and emits no audit event, but a longer interval keeps
  // it quiet even under a secrets.read=approve policy.
  const { data, error, reload } = usePoll(() => api.secretTree(projectId), [projectId], 30000)
  const [dialog, setDialog] = useState<{ editing: Row | null } | null>(null)
  const [approval, setApproval] = useState<PendingApproval>(null)
  const [actionError, setActionError] = useState<string>()

  const remove = async (row: Row) => {
    setActionError(undefined)
    const r = await api.unsetSecret(projectId, row.name, row.scope === 'branch' ? branch : undefined)
    if (r.kind === 'approval') return setApproval({ ...r, retry: () => remove(row) })
    if (r.kind === 'error') return setActionError(r.error)
    reload()
  }

  const rows = data ? rowsFor(data, branch) : []

  return (
    <div className="mx-auto flex w-full max-w-[64rem] flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-[32px] leading-12 font-bold">Secrets</h1>
          <p className="text-sm text-muted-foreground">
            Environment variables for <span className="font-medium">{branch}</span> — names only.
            Values stay behind <code className="font-mono text-[13px]">insta secrets</code>.
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
              <th className="px-4 py-3 text-left text-[13px] font-normal text-muted-foreground">Name</th>
              <th className="w-44 px-4 py-3 text-left text-[13px] font-normal text-muted-foreground">Source</th>
              <th className="w-28 px-4 py-3 text-left text-[13px] font-normal text-muted-foreground">Type</th>
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
              rows.map((row) => (
                <tr key={`${row.source}:${row.name}`} className="border-b border-border last:border-b-0">
                  <td className="truncate px-4 py-2.5 font-mono text-[13px]">{row.name}</td>
                  <td className="truncate px-4 py-2.5 text-[13px] text-muted-foreground">{row.source}</td>
                  <td className="px-4 py-2.5">
                    <span className={cn('rounded-md px-1.5 py-0.5 text-xs font-medium',
                      row.managed ? 'bg-alpha-8 text-muted-foreground' : 'bg-success/10 text-success')}>
                      {row.managed ? 'Managed' : 'User'}
                    </span>
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    {!row.managed && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.name}`}>
                            <EllipsisVertical className="size-4 text-muted-foreground" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setDialog({ editing: row })}>Update Value</DropdownMenuItem>
                          <DropdownMenuItem className="text-destructive focus:text-destructive"
                            onSelect={() => remove(row)}>
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
