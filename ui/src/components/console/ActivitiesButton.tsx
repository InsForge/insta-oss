// The console's topbar "Activities" button. Self-host divergence: the daemon enforces approvals,
// which the console only toasts about, so a pending count rides the button and a click while any
// are waiting opens Approvals; otherwise it opens the operations timeline.

import { useNavigate } from 'react-router-dom'
import { Button } from '@insforge/ui'
import { History } from 'lucide-react'
import { api } from '../../api'
import { usePoll } from '../../hooks'

export function ActivitiesButton({ projectId, branch }: { projectId: string; branch: string }) {
  const nav = useNavigate()
  const { data: approvals } = usePoll(() => api.approvals(projectId), [projectId], 10_000)
  const pending = approvals?.filter((a) => a.status === 'pending').length ?? 0
  return (
    <Button variant="secondary" size="sm" className="h-9 gap-1.5 text-muted-foreground hover:text-primary"
      title={pending ? `${pending} approval${pending === 1 ? '' : 's'} waiting` : 'Recent activity'}
      onClick={() => nav(`/p/${projectId}/${branch}/${pending ? 'approvals' : 'operations'}`)}>
      <History className="size-4" />
      Activities
      {pending > 0 && <span className="rounded-full bg-warning px-1.5 text-[11px] font-semibold text-inverse">{pending}</span>}
    </Button>
  )
}
