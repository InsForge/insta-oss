import { useState } from 'react'
import { useAuth } from './AuthGate'
import {
  Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch,
} from '@insforge/ui'
import { api, type ServiceType } from '../api'
import type { PendingApproval } from './ApprovalPrompt'
import { ErrorNote, Field, Modal } from './ui'

/** The cloud's service-name rule: lower-kebab, 1 to 39 chars. */
export const SERVICE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$/

const TYPES: Array<{ key: ServiceType; label: string }> = [
  { key: 'compute', label: 'Compute (app container)' },
  { key: 'postgres', label: 'Postgres' },
  { key: 'storage', label: 'Storage (S3 bucket)' },
  { key: 'redis', label: 'Redis' },
  { key: 'mysql', label: 'MySQL' },
  { key: 'mongodb', label: 'MongoDB' },
]

/** `POST /projects/:id/services` for every type the cloud accepts (plan 07 J). */
export function AddServiceDialog({ projectId, branch, onClose, onDone, onApproval }: {
  projectId: string; branch: string; onClose: () => void; onDone: () => void
  onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const [type, setType] = useState<ServiceType>('compute')
  const [name, setName] = useState('')
  const [image, setImage] = useState('')
  const [port, setPort] = useState('8080')
  // Starts where the daemon's default is (on, like the hosted platform), and is sent ONLY when the
  // user flips it: an explicit value pins the service on every branch, while an untouched one
  // leaves the default branch always-on and lets branch clones scale to zero.
  const { boot } = useAuth()
  const [alwaysOn, setAlwaysOnState] = useState(boot.alwaysOnDefault)
  const [alwaysOnTouched, setAlwaysOnTouched] = useState(false)
  const setAlwaysOn = (v: boolean): void => { setAlwaysOnState(v); setAlwaysOnTouched(true) }
  const [withVolume, setWithVolume] = useState(false)
  const [volumeGib, setVolumeGib] = useState('1')
  const [isPublic, setIsPublic] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const n = name.trim()
  const nameOk = SERVICE_NAME_RE.test(n)
  const portNum = Number(port)
  const portOk = type !== 'compute' || !image.trim() || (Number.isInteger(portNum) && portNum > 0 && portNum < 65536)
  const volOk = type !== 'compute' || !withVolume || (Number.isInteger(Number(volumeGib)) && Number(volumeGib) >= 1)
  const valid = nameOk && portOk && volOk

  const submit = async () => {
    if (!valid) return setError(nameOk ? 'check the port and volume size' : 'Names are lower-case letters, digits and hyphens (max 39).')
    setBusy(true); setError(undefined)
    const body: Parameters<typeof api.addService>[1] = { type, name: n, branch }
    if (type === 'compute') {
      if (image.trim()) { body.image = image.trim(); body.port = portNum }
      if (alwaysOnTouched) body.alwaysOn = alwaysOn
      if (withVolume) body.volumeGib = Number(volumeGib)
    }
    if (type === 'storage') body.public = isPublic
    const r = await api.addService(projectId, body)
    setBusy(false)
    if (r.kind === 'error') {
      if (r.status === 409) return setError(`A ${type} named ${n} already exists.`)
      return setError(r.error)
    }
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
          <Button variant="primary" onClick={submit} disabled={busy || !valid}>{busy ? 'Adding' : 'Add'}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Type">
          <Select value={type} onValueChange={(v) => setType(v as ServiceType)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {TYPES.map((t) => <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Name" hint={n && !nameOk ? <span className="text-destructive">Lower-case letters, digits and hyphens; max 39 characters.</span> : 'Lower-kebab, like web or cache.'}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder={type === 'compute' ? 'web' : type === 'storage' ? 'uploads' : 'db'} className="font-mono" />
        </Field>

        {type === 'compute' && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Image (optional)" className="col-span-2" hint="Leave blank to deploy later with insta deploy.">
                <Input value={image} onChange={(e) => setImage(e.target.value)} placeholder="ghcr.io/acme/web:1.2.3" className="font-mono" />
              </Field>
              <Field label="Port">
                <Input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} disabled={!image.trim()} />
              </Field>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium">Always on</p>
                <p className="text-xs text-muted-foreground">Off: sleeps when idle and wakes on request</p>
              </div>
              <Switch checked={alwaysOn} onCheckedChange={setAlwaysOn} aria-label="Always on" />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium">Persistent volume</p>
                <p className="text-xs text-muted-foreground">A /data disk that survives redeploys.</p>
              </div>
              <div className="flex items-center gap-2">
                {withVolume && (
                  <span className="flex items-center gap-1 text-sm">
                    <Input type="number" min={1} value={volumeGib} onChange={(e) => setVolumeGib(e.target.value)} className="w-16" />
                    Gi
                  </span>
                )}
                <Switch checked={withVolume} onCheckedChange={setWithVolume} aria-label="Attach a volume" />
              </div>
            </div>
          </>
        )}

        {type === 'storage' && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
            <div>
              <p className="text-sm font-medium">Public</p>
              <p className="text-xs text-muted-foreground">Anyone with a URL can read objects.</p>
            </div>
            <Switch checked={isPublic} onCheckedChange={setIsPublic} aria-label="Public bucket" />
          </div>
        )}

        {(type === 'postgres' || type === 'redis' || type === 'mysql' || type === 'mongodb') && (
          <p className="text-xs text-muted-foreground">
            A private instance per environment with fresh credentials, bound into apps as env vars. It sleeps when idle and wakes on the next connection.
          </p>
        )}
        <ErrorNote error={error} />
      </div>
    </Modal>
  )
}
