// The Service page, ported from the console (insta-frontend services/service-view.tsx, list view):
// a title band, Add Service in the corner, the card table, and the dashed empty-state CTA that opens
// the "Add Your Service" picker. Self-host divergences: no canvas view yet, and no agent-connect
// panel on the empty state.

import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { cn, Switch } from '@insforge/ui'
import { api, type Service } from '../api'
import { usePoll, useWaking } from '../hooks'
import { healthFor } from '../lib/status'
import { ApprovalPrompt, type PendingApproval } from '../components/ApprovalPrompt'
import { AddFirstServiceDialog, AddServiceButton } from '../components/console/AddService'
import { ServiceTable } from '../components/console/ServiceTable'
import { ErrorNote } from '../components/ui'

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

export function Services() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  const nav = useNavigate()
  const waking = useWaking()
  const interval = waking.anyWaking ? 2000 : 5000
  const { data: services, error, reload } = usePoll(() => api.services(projectId, branch), [projectId, branch], interval)
  const { data: health } = usePoll(() => api.runtimeHealth(projectId, branch), [projectId, branch], interval)
  const [approval, setApproval] = useState<PendingApproval>(null)
  const [actionError, setActionError] = useState<string>()
  const [addFirstOpen, setAddFirstOpen] = useState(false)

  useEffect(() => { waking.reconcile(health, healthFor) }, [health, waking])

  const rows = services ?? []
  const empty = services !== undefined && rows.length === 0
  const flow = { projectId, branch, services: rows, onDone: reload, onApproval: setApproval }

  return (
    // A title band spanning the content column (escaping <main>'s padding), then the rows at a
    // 24px inset, as on the console.
    <div className={cn('relative -mx-8 -mt-8 flex w-auto flex-col gap-4', empty && '-mb-6 min-h-[420px] flex-1')}>
      <div className="px-6">
        <div className="flex items-center py-4.5">
          <h1 className="text-[32px] leading-12 font-semibold">Service</h1>
        </div>
      </div>
      <div className="absolute top-6 right-6 z-10">
        <AddServiceButton {...flow} />
      </div>
      {empty ? (
        <div className="px-6">
          <button type="button" onClick={() => setAddFirstOpen(true)}
            className="flex w-full cursor-pointer flex-col items-center justify-center gap-3 border border-dashed border-alpha-16 bg-semantic-2 px-6 py-10 transition-colors hover:bg-card">
            <span className="text-xl leading-7 font-medium">No Service Deployed</span>
            <span className="text-sm leading-6 text-muted-foreground">Add your first service</span>
          </button>
        </div>
      ) : (
        <div className="flex flex-col px-6">
          <ServiceTable projectId={projectId} branch={branch} services={rows} health={health} isWaking={waking.isWaking}
            onOpen={(s) => nav(`/p/${projectId}/${branch}/services/${s.id}`)}
            onDone={reload} onError={setActionError} onApproval={setApproval} />
        </div>
      )}
      {(actionError || error) && <div className="px-6"><ErrorNote error={actionError ?? error} /></div>}
      <AddFirstServiceDialog {...flow} open={addFirstOpen} onOpenChange={setAddFirstOpen} />
      <ApprovalPrompt projectId={projectId} pending={approval} onClose={() => setApproval(null)} />
    </div>
  )
}
