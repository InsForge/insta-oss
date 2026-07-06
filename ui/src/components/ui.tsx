import { useEffect, type ReactNode } from 'react'

/** Runtime → dot + label, mock-style. */
export function StatusDot({ runtime }: { runtime?: string }) {
  const map: Record<string, { color: string; label: string }> = {
    online: { color: 'bg-green-500 text-green-600', label: 'Online' },
    stopped: { color: 'bg-neutral-400 text-neutral-500', label: 'Stopped' },
    none: { color: 'bg-neutral-300 text-neutral-400', label: 'Not deployed' },
  }
  const m = map[runtime ?? ''] ?? { color: 'bg-neutral-300 text-neutral-400', label: '—' }
  const [dot, text] = m.color.split(' ')
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm ${text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {m.label}
    </span>
  )
}

export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded border border-amber-400 px-1.5 py-px text-[11px] font-medium text-amber-600">
      {children}
    </span>
  )
}

export function Button({ children, onClick, kind = 'primary', disabled, title }: {
  children: ReactNode; onClick?: () => void; kind?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; title?: string
}) {
  const styles = {
    primary: 'bg-green-600 text-white hover:bg-green-700',
    ghost: 'border border-neutral-200 text-neutral-700 hover:bg-neutral-50',
    danger: 'border border-red-200 text-red-600 hover:bg-red-50',
  }[kind]
  return (
    <button
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
      onClick={onClick} disabled={disabled} title={title}
    >
      {children}
    </button>
  )
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-4 text-base font-semibold text-neutral-800">{title}</h3>
        {children}
      </div>
    </div>
  )
}

export function ErrorNote({ error }: { error?: Error | string }) {
  if (!error) return null
  return (
    <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {typeof error === 'string' ? error : error.message}
    </p>
  )
}

/** Service-type glyph (kept dependency-free: no icon lib). */
export function TypeIcon({ type }: { type: string }) {
  const glyph = type === 'postgres' ? '🐘' : type === 'storage' ? '🪣' : '📦'
  return (
    <span className="grid h-9 w-9 place-items-center rounded-full border border-neutral-200 bg-white text-lg">
      {glyph}
    </span>
  )
}
