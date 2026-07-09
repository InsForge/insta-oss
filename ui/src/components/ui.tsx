import { type ReactNode } from 'react'
import {
  cn,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@insforge/ui'
import { Database, HardDrive, Server, type LucideIcon } from 'lucide-react'

/** Runtime → dot + label, styled like insta-frontend's service StatusCell. */
export function StatusDot({ runtime }: { runtime?: string }) {
  const map: Record<string, { dot: string; text: string; label: string }> = {
    online: { dot: 'bg-success', text: 'text-success', label: 'Online' },
    stopped: { dot: 'bg-disabled', text: 'text-muted-foreground', label: 'Stopped' },
    none: { dot: 'bg-disabled', text: 'text-muted-foreground', label: 'Not deployed' },
  }
  const m = map[runtime ?? ''] ?? { dot: 'bg-disabled', text: 'text-muted-foreground', label: '—' }
  return (
    <span className={cn('inline-flex items-center gap-2 text-sm', m.text)}>
      <span className={cn('size-1.5 rounded-full', m.dot)} />
      {m.label}
    </span>
  )
}

/** Environment status chip — same styles as insta-frontend's EnvStatusBadge. */
export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md bg-warning px-2 py-0.5 text-xs font-medium text-inverse">
      {children}
    </span>
  )
}

/** Controlled modal over the @insforge/ui Radix dialog (no trigger — pages open it from state). */
export function Modal({ title, onClose, children, footer }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>{children}</DialogBody>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  )
}

export function ErrorNote({ error }: { error?: Error | string }) {
  if (!error) return null
  return <p className="mt-3 text-sm text-destructive">{typeof error === 'string' ? error : error.message}</p>
}

/** Service-type icon on a semantic surface, like insta-frontend's ServiceTypeIcon tile
 *  (lucide Database instead of the postgres brand mark — no simple-icons dependency here). */
export function TypeIcon({ type }: { type: string }) {
  const Icon: LucideIcon = type === 'postgres' ? Database : type === 'storage' ? HardDrive : Server
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-semantic-1">
      <Icon className="size-5 text-muted-foreground" />
    </span>
  )
}
