// The console's Environments page (insta-frontend environments/environments-view.tsx,
// environment-actions-menu.tsx): a title band with Add Environment, then a table of Environment,
// Status, Service (type icons), Created. The default environment has no menu (it cannot be
// deleted). Self-host divergences: no Rename Environment (the daemon has no branch rename), and no
// GitHub deployments panel.

import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Button, ConfirmDialog, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@insforge/ui'
import { CircleAlert, EllipsisVertical, Plus } from 'lucide-react'
import { api, type BranchInfo } from '../api'
import { usePoll } from '../hooks'
import { envBadge } from '../lib/envSwitch'
import { ApprovalPrompt, type PendingApproval } from '../components/ApprovalPrompt'
import { CreateEnvironmentDialog } from '../components/console/CreateEnvironmentDialog'
import { EnvStatusBadge } from '../components/console/EnvSwitcher'
import { ServiceTypeIcon } from '../components/console/ServiceIcon'
import { createdDate } from '../components/console/ServiceTable'
import { ErrorNote } from '../components/ui'

function Th({ children }: { children?: string }) {
  return <th className="px-4 py-3 text-left text-[13px] font-normal text-muted-foreground">{children}</th>
}

/** One icon per service type the environment carries. */
function ServiceIcons({ projectId, env }: { projectId: string; env: string }) {
  const { data } = usePoll(() => api.services(projectId, env), [projectId, env], 30_000)
  if (!data) return <span className="text-sm text-muted-foreground">…</span>
  const types = [...new Set(data.map((s) => s.type))]
  if (types.length === 0) return <span className="text-sm text-muted-foreground">—</span>
  return (
    <div className="flex items-center gap-2">
      {types.map((type) => (
        <span key={type} className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-semantic-1">
          <ServiceTypeIcon type={type} className="size-5" />
        </span>
      ))}
    </div>
  )
}

function EnvironmentActionsMenu({ projectId, env, onDeleted, onError, onApproval }: {
  projectId: string; env: BranchInfo; onDeleted: () => void
  onError: (m: string) => void; onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const remove = async () => {
    setBusy(true)
    const r = await api.deleteBranch(projectId, env.id)
    setBusy(false)
    setDeleteOpen(false)
    if (r.kind === 'error') return onError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void remove() } })
    onDeleted()
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${env.name}`}>
            <EllipsisVertical className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleteOpen(true)}>
            Delete Environment
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} title="Delete Environment"
        description={
          <span>
            This permanently deletes <span className="font-medium">{env.name}</span> and tears down its database branch,
            storage fork, and compute. This action cannot be undone.
          </span>
        }
        confirmText="Delete" cancelText="Cancel" destructive isLoading={busy} onConfirm={() => { void remove() }} />
    </>
  )
}

export function Environments() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  const nav = useNavigate()
  const { data: envs, reload } = usePoll(() => api.branches(projectId), [projectId])
  const [createOpen, setCreateOpen] = useState(false)
  const [approval, setApproval] = useState<PendingApproval>(null)
  const [error, setError] = useState<string>()
  const all = envs ?? []
  const defaultEnv = all.find((e) => e.is_default)?.name ?? 'main'

  return (
    <div className="-mx-8 -mt-8 flex w-auto flex-col gap-4">
      <div className="px-6">
        <div className="flex items-center justify-between gap-3 py-4.5">
          <h1 className="text-[32px] leading-12 font-semibold">Environments</h1>
          <Button variant="primary" className="h-9 gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            Add Environment
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-4 px-6">
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <Th>Environment</Th>
                <Th>Status</Th>
                <Th>Service</Th>
                <Th>Created</Th>
                <th className="w-12" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {all.map((env) => {
                // A branch whose teardown failed keeps its row so the delete can be retried; nothing
                // inside it works, so it does not open, but it keeps its menu.
                const failed = envBadge(env).label === 'Failed'
                return (
                  <tr key={env.id} onClick={failed ? undefined : () => nav(`/p/${projectId}/${env.name}/services`)}
                    className={cn('border-b border-border transition-colors last:border-b-0',
                      failed ? 'opacity-60' : 'cursor-pointer hover:bg-alpha-4')}>
                    <td className="px-4 py-3 text-sm">{env.name}</td>
                    <td className="px-4 py-3">
                      {failed ? (
                        <span className="flex items-center gap-2 text-sm text-destructive"
                          title="This environment could not be torn down. Delete it again to retry.">
                          <CircleAlert className="size-4" />
                          Failed
                        </span>
                      ) : (
                        <EnvStatusBadge env={env} />
                      )}
                    </td>
                    <td className="px-4 py-3"><ServiceIcons projectId={projectId} env={env.name} /></td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{createdDate(env.created_at)}</td>
                    {env.is_default ? (
                      <td className="w-12" />
                    ) : (
                      <td className="px-2 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                        <EnvironmentActionsMenu projectId={projectId} env={env} onError={setError} onApproval={setApproval}
                          onDeleted={() => {
                            reload()
                            // The environment you were standing on is gone: land on the default one.
                            if (env.name === branch) nav(`/p/${projectId}/${defaultEnv}/env`, { replace: true })
                          }} />
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <ErrorNote error={error} />
      </div>

      <CreateEnvironmentDialog projectId={projectId} environments={all} open={createOpen} onOpenChange={setCreateOpen}
        onCreated={(name) => { reload(); nav(`/p/${projectId}/${name}/services`) }} onApproval={setApproval} />
      <ApprovalPrompt projectId={projectId} pending={approval} onClose={() => setApproval(null)} />
    </div>
  )
}
