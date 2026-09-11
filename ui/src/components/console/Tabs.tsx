// The console's two tab forms: SideTabs, the vertical rail of the service detail
// (insta-frontend side-tabs.tsx), and TopTabs, the underlined bar inside a tab (top-tabs.tsx).

import { cn } from '@insforge/ui'
import { RefreshCw } from 'lucide-react'

export function SideTabs<T extends string>({ tabs, value, onChange, className }: {
  tabs: readonly { id: T; label: string }[]; value: T; onChange: (id: T) => void; className?: string
}) {
  return (
    <div role="tablist" aria-orientation="vertical" className={cn('flex w-50 shrink-0 flex-col', className)}>
      {tabs.map(({ id, label }) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} onClick={() => onChange(id)}
          className={cn('flex h-10 items-center px-4 text-left text-sm transition-colors',
            value === id ? 'bg-card font-medium text-foreground' : 'text-muted-foreground hover:bg-alpha-4 hover:text-foreground')}>
          {label}
        </button>
      ))}
    </div>
  )
}

export function TopTabs<T extends string>({ tabs, value, onChange, label, className }: {
  tabs: readonly { id: T; label: string }[]; value: T; onChange: (id: T) => void; label: string; className?: string
}) {
  return (
    <div role="tablist" aria-label={label} className={cn('flex items-center gap-6 border-b border-border', className)}>
      {tabs.map(({ id, label: tabLabel }) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} onClick={() => onChange(id)}
          className="flex flex-col items-center gap-3 pt-1 outline-none focus-visible:ring-2">
          <span className={cn('text-[13px] transition-colors', value === id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}>
            {tabLabel}
          </span>
          <span aria-hidden className={cn('h-0.5 w-full', value === id ? 'bg-foreground' : 'bg-transparent')} />
        </button>
      ))}
    </div>
  )
}

/** Live-progress row status: a spinner, not a dot (the console's DeployingBadge). */
export function DeployingBadge({ label = 'Deploying' }: { label?: string }) {
  return (
    <span className="flex items-center gap-2 text-sm text-info">
      <RefreshCw className="size-4 animate-spin" />
      {label}
    </span>
  )
}
