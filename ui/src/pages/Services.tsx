import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Button, ConfirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger, EmptyState, Input, Switch,
} from '@insforge/ui'
import { Box, EllipsisVertical, Plus, Rocket } from 'lucide-react'
import { api, relTime, type Service } from '../api'
import { usePoll, useWaking } from '../hooks'
import { deriveStatus, healthFor } from '../lib/status'
import { useAuth } from '../components/AuthGate'
import { AddServiceDialog, SERVICE_NAME_RE } from '../components/AddServiceDialog'
import { ApprovalPrompt, type PendingApproval } from '../components/ApprovalPrompt'
import { DeployDialog } from '../components/DeployDialog'
import { ErrorNote, HostLink, Modal, StatusCell, TypeIcon } from '../components/ui'

const MANAGED = new Set(['redis', 'mysql', 'mongodb'])
const DB_LABEL: Record<string, string> = { postgres: 'Postgres', redis: 'Redis', mysql: 'MySQL', mongodb: 'MongoDB', storage: 'Storage' }

function RenameDialog({ projectId, branch, service, onClose, onDone, onApproval }: {
  projectId: string; branch: string; service: Service; onClose: () => void; onDone: () => void
  onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const [name, setName] = useState(service.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const n = name.trim()
  const valid = SERVICE_NAME_RE.test(n)

  const submit = async () => {
    if (!valid) return setError('Lower-case letters, digits and hyphens; max 39 characters.')
    setBusy(true); setError(undefined)
    const r = await api.renameService(projectId, service.id, n, branch)
    setBusy(false)
    if (r.kind === 'error') return setError(r.status === 409 ? `A service named ${n} already exists.` : r.error)
    if (r.kind === 'approval') { onClose(); return onApproval({ ...r, retry: submit }) }
    onClose(); onDone()
  }

  return (
    <Modal title="Rename service" onClose={onClose} footer={
      <>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={busy || !valid}>Rename</Button>
      </>
    }>
      <label className="text-xs font-medium text-muted-foreground">New name</label>
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()} className="mt-1 font-mono" />
      <p className="mt-3 text-xs text-muted-foreground">
        Lower-kebab (a-z, 0-9, hyphen). The container and any bound secrets follow the rename.
      </p>
      <ErrorNote error={error} />
    </Modal>
  )
}

/** Always-on for compute and managed rows: `PUT /services/:sid/always-on {enabled}`. */
export function AlwaysOnSwitch({ projectId, branch, service, onDone, onError, onApproval }: {
  projectId: string; branch: string; service: Service; onDone: () => void
  onError: (m: string) => void; onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const [busy, setBusy] = useState(false)
  const set = async (enabled: boolean) => {
    setBusy(true)
    const r = await api.setAlwaysOn(projectId, service.id, enabled, branch)
    setBusy(false)
    if (r.kind === 'error') return onError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => set(enabled) })
    onDone()
  }
  return (
    <Switch checked={!!service.always_on} disabled={busy} onCheckedChange={set}
      aria-label={`Always on for ${service.name}`} onClick={(e) => e.stopPropagation()} />
  )
}

/** Postgres has no always-on column: the same intent is scale-to-zero, inverted (decision 48). */
export function PgAlwaysOnSwitch({ projectId, branch, group, onError, onApproval }: {
  projectId: string; branch: string; group: string
  onError: (m: string) => void; onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const { data, reload } = usePoll(() => api.dbInstance(projectId, branch, group), [projectId, branch, group], 15000)
  const [busy, setBusy] = useState(false)
  const set = async (checked: boolean) => {
    setBusy(true)
    const r = await api.dbSettings(projectId, branch, { scaleToZero: !checked }, group)
    setBusy(false)
    if (r.kind === 'error') return onError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => set(checked) })
    reload()
  }
  return (
    <Switch checked={data ? !data.scaleToZero : false} disabled={busy || !data} onCheckedChange={set}
      aria-label={`Always on for ${group}`} onClick={(e) => e.stopPropagation()} />
  )
}

function RowMenu({ projectId, branch, service, online, onError, onDone, onRename, onRemove, onApproval }: {
  projectId: string; branch: string; service: Service; online: boolean
  onError: (m: string) => void; onDone: () => void; onRename: () => void; onRemove: () => void
  onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const life = async (verb: 'start' | 'stop' | 'suspend' | 'restart') => {
    const r = await api.lifecycle(projectId, service.id, verb, branch)
    if (r.kind === 'error') return onError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => life(verb) })
    onDone()
  }
  const access = async (isPublic: boolean) => {
    const r = await api.setAccess(projectId, service.id, isPublic, branch)
    if (r.kind === 'error') return onError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => access(isPublic) })
    onDone()
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${service.name}`} onClick={(e) => e.stopPropagation()}>
          <EllipsisVertical className="size-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {service.type === 'compute' && (
          <>
            {online
              ? <>
                  <DropdownMenuItem onSelect={() => life('restart')}>Restart</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => life('stop')}>Stop</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => life('suspend')}>Suspend</DropdownMenuItem>
                </>
              : <>
                  <DropdownMenuItem onSelect={() => life('start')}>Start</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => life('restart')}>Restart</DropdownMenuItem>
                </>}
            <DropdownMenuSeparator />
          </>
        )}
        {service.type === 'storage' && (
          <DropdownMenuItem onSelect={() => access(!service.public)}>
            {service.public ? 'Make private' : 'Make public'}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem>
        <DropdownMenuItem onSelect={onRemove} className="text-destructive">Remove</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Services() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  const { mode } = useAuth()
  const nav = useNavigate()
  const waking = useWaking()
  const interval = waking.anyWaking ? 2000 : 5000
  const { data: services, error, reload } = usePoll(() => api.services(projectId, branch), [projectId, branch], interval)
  const { data: health } = usePoll(() => api.runtimeHealth(projectId, branch), [projectId, branch], interval)
  const [deploying, setDeploying] = useState(false)
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<Service | null>(null)
  const [removing, setRemoving] = useState<Service | null>(null)
  const [approval, setApproval] = useState<PendingApproval>(null)
  const [actionError, setActionError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => { waking.reconcile(health, healthFor) }, [health, waking])

  const rows = services ?? []
  const compute = useMemo(() => rows.filter((s) => s.type === 'compute'), [rows])

  const wake = async (s: Service) => {
    setActionError(undefined)
    const r = await api.lifecycle(projectId, s.id, 'start', branch)
    if (r.kind === 'error') return setActionError(r.error)
    if (r.kind === 'approval') return setApproval({ ...r, retry: () => wake(s) })
    waking.wake(s.id)
    reload()
  }

  const remove = async () => {
    if (!removing) return
    setBusy(true); setActionError(undefined)
    const r = await api.removeService(projectId, removing.id, branch)
    setBusy(false)
    const target = removing
    setRemoving(null)
    if (r.kind === 'error') return setActionError(r.error)
    if (r.kind === 'approval') return setApproval({ ...r, retry: () => { setRemoving(target); void remove() } })
    reload()
  }

  const markDeployed = (group: string) => {
    const row = compute.find((s) => s.name === group)
    if (row) waking.wake(row.id)
  }

  return (
    <div className="mx-auto flex w-full max-w-[64rem] flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[32px] leading-12 font-bold">Service</h1>
        <div className="flex items-center gap-2">
          <Button variant="secondary" className="gap-1.5" onClick={() => setAdding(true)}>
            <Plus className="size-4" /> Add Service
          </Button>
          <Button variant="primary" className="gap-1.5" onClick={() => setDeploying(true)}>
            <Rocket className="size-4" /> Deploy
          </Button>
        </div>
      </div>

      {services && rows.length === 0 ? (
        <EmptyState icon={Box} title="No services yet"
          description="Add a database or storage, or deploy an app or a template."
          action={{ label: 'Add service', onClick: () => setAdding(true) }} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="px-4 py-3 text-left text-sm font-normal text-muted-foreground">Service</th>
                <th className="px-4 py-3 text-left text-sm font-normal text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-left text-sm font-normal text-muted-foreground">URL</th>
                <th className="px-4 py-3 text-left text-sm font-normal text-muted-foreground">Always on</th>
                <th className="px-4 py-3 text-left text-sm font-normal text-muted-foreground">Updated</th>
                <th className="w-12" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const h = healthFor(health, s.id)
                const status = deriveStatus(s, h, waking.isWaking(s.id))
                return (
                  <tr key={s.id} className="group cursor-pointer border-b border-border last:border-b-0 hover:bg-alpha-4"
                    onClick={() => nav(`/p/${projectId}/${branch}/services/${s.id}`)}>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-3">
                        <TypeIcon type={s.type} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{s.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {s.template_code ? `${DB_LABEL[s.type] ?? 'Compute'} · ${s.template_code}` : DB_LABEL[s.type] ?? 'Compute'}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <StatusCell row={s} health={h} waking={waking.isWaking(s.id)} onWake={() => wake(s)} />
                    </td>
                    <td className="max-w-56 px-4 py-2">
                      <HostLink domain={s.domain} endpoint={s.endpoint} mode={mode} link={s.type === 'compute'}
                        sleeping={status.kind === 'sleeping'} />
                    </td>
                    <td className="px-4 py-2">
                      {s.type === 'compute' || MANAGED.has(s.type) ? (
                        <AlwaysOnSwitch projectId={projectId} branch={branch} service={s} onDone={reload}
                          onError={setActionError} onApproval={setApproval} />
                      ) : s.type === 'postgres' ? (
                        <PgAlwaysOnSwitch projectId={projectId} branch={branch} group={s.name}
                          onError={setActionError} onApproval={setApproval} />
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-sm text-muted-foreground">{relTime(s.updated_at)}</td>
                    <td className="px-2 py-2 text-right">
                      <RowMenu projectId={projectId} branch={branch} service={s} online={status.kind === 'online'}
                        onError={setActionError} onDone={reload} onRename={() => setRenaming(s)}
                        onRemove={() => setRemoving(s)} onApproval={setApproval} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <ErrorNote error={actionError ?? error} />

      {deploying && (
        <DeployDialog projectId={projectId} branch={branch} services={rows} onClose={() => setDeploying(false)}
          onDone={reload} onDeployed={markDeployed} onApproval={setApproval} />
      )}
      {adding && (
        <AddServiceDialog projectId={projectId} branch={branch} onClose={() => setAdding(false)} onDone={reload}
          onApproval={setApproval} />
      )}
      {renaming && (
        <RenameDialog projectId={projectId} branch={branch} service={renaming} onClose={() => setRenaming(null)}
          onDone={reload} onApproval={setApproval} />
      )}
      <ConfirmDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} title="Remove service"
        description={`${removing?.name ?? 'This service'} and its data are destroyed. This cannot be undone.`}
        confirmText="Remove" destructive isLoading={busy} onConfirm={remove} />
      <ApprovalPrompt projectId={projectId} pending={approval} onClose={() => setApproval(null)} />
    </div>
  )
}
