import { useState } from 'react'
import { api, type ApiResult } from '../api'
import { Button, Dialog, ErrorNote } from './ui'

export type PendingApproval = { action: string; approvalId: string; retry: () => void } | null

/** Shared HITL modal: any mutation that came back 202 lands here; granting retries the mutation
 *  (grants are one-shot server-side, mirroring the CLI's `insta approvals approve` flow). */
export function ApprovalPrompt({ projectId, pending, onClose }: {
  projectId: string; pending: PendingApproval; onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (!pending) return null

  const decide = async (verdict: 'approve' | 'deny', always = false) => {
    setBusy(true)
    setError(undefined)
    const r: ApiResult<unknown> = await api.decide(projectId, pending.approvalId, verdict, always)
    setBusy(false)
    if (r.kind === 'error') return setError(r.error)
    onClose()
    if (verdict === 'approve') pending.retry()
  }

  return (
    <Dialog title="Approval required" onClose={onClose}>
      <p className="text-sm text-neutral-600">
        Policy gates <code className="rounded bg-neutral-100 px-1 font-mono text-[13px]">{pending.action}</code> behind
        a human decision. Grant it to run this action once, or grant always to stop asking.
      </p>
      <ErrorNote error={error} />
      <div className="mt-5 flex justify-end gap-2">
        <Button kind="danger" onClick={() => decide('deny')} disabled={busy}>Deny</Button>
        <Button kind="ghost" onClick={() => decide('approve', true)} disabled={busy}>Grant always</Button>
        <Button onClick={() => decide('approve')} disabled={busy}>Grant once</Button>
      </div>
    </Dialog>
  )
}
