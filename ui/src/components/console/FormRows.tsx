// The console's create-dialog rows (insta-frontend services/service-form-rows.tsx): a 240px label
// column with an optional hint, the control on the right; Advanced Settings hides options that
// already have a working default.

import type { ReactNode } from 'react'
import { DialogDivider, Input, Switch } from '@insforge/ui'
import { ChevronRight } from 'lucide-react'

export const DEFAULT_VOLUME_GIB = 1

export function FormRow({ label, hint, children }: { label: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-6">
      <div className="flex w-60 shrink-0 flex-col gap-2">
        <span className="py-1.5 text-sm">{label}</span>
        {hint && <p className="pb-2 text-[13px] text-muted-foreground">{hint}</p>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function AdvancedSettings({ open, onOpenChange, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode
}) {
  return (
    <>
      <DialogDivider />
      <button type="button" aria-expanded={open} onClick={() => onOpenChange(!open)}
        className="flex items-center gap-1.5 self-start py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className={`size-4 transition-transform ${open ? 'rotate-90' : ''}`} />
        Advanced Settings
      </button>
      {open && children}
    </>
  )
}

/** The compute create dialogs' Volume row. A volume can also be attached later from the service's
 *  Volume tab, but creating with one saves the redeploy a later attach needs. */
export function VolumeFormRow({ enabled, onEnabledChange, sizeGib, onSizeChange }: {
  enabled: boolean; onEnabledChange: (enabled: boolean) => void; sizeGib: string; onSizeChange: (sizeGib: string) => void
}) {
  return (
    <>
      <DialogDivider />
      <FormRow label="Volume"
        hint="A persistent disk mounted at /data. You can also attach one later from the service's Volume tab.">
        <div className="flex flex-col gap-2">
          <Switch checked={enabled} onCheckedChange={onEnabledChange} aria-label="Attach volume" />
          {enabled && (
            <div className="flex items-center gap-2">
              <Input name="volumeGib" inputMode="numeric" className="w-24" placeholder={String(DEFAULT_VOLUME_GIB)}
                value={sizeGib} onChange={(e) => onSizeChange(e.target.value)} aria-label="Volume size in GB" />
              <span className="text-sm text-muted-foreground">GB</span>
            </div>
          )}
        </div>
      </FormRow>
    </>
  )
}
