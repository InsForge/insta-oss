import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import {
  Button, ConfirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@insforge/ui'
import { ArrowLeft, EllipsisVertical, KeyRound, LogOut } from 'lucide-react'
import { api, relTime, type ApiToken } from '../api'
import { useAuth } from '../components/AuthGate'
import { TokenCreate } from '../components/TokenCreate'
import { ErrorNote } from '../components/ui'
import { usePoll } from '../hooks'
import { apiUrlForCli } from '../lib/apiUrl'

function fmtDate(iso: string | null): string {
  if (!iso) return 'never'
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Minimal shell for account pages: back to the dashboard, who is signed in, sign out. */
function AccountShell({ children }: { children: React.ReactNode }) {
  const auth = useAuth()
  const nav = useNavigate()
  const signOut = async () => { await auth.signOut(); nav('/login', { replace: true }) }
  return (
    <div className="min-h-screen bg-semantic-0">
      <header className="flex h-12 items-center justify-between border-b border-border px-4">
        <Link to="/" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Dashboard
        </Link>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>{auth.user?.email ?? auth.user?.name ?? ''}</span>
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={signOut}><LogOut className="size-4" /> Sign out</Button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[48rem] px-8 pt-8 pb-6">{children}</main>
    </div>
  )
}

/** Account > API tokens (server mode only): list, mint, revoke `insta_` keys. */
export function Tokens() {
  const auth = useAuth()
  const { data: tokens, error, reload } = usePoll(api.tokens, [], 30000)
  const [revoking, setRevoking] = useState<ApiToken | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()

  if (auth.mode !== 'server') return <Navigate to="/" replace />

  const rows = (tokens ?? []).filter((t) => !t.revokedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const apiUrl = auth.boot.apiUrl || apiUrlForCli(location.origin)

  const revoke = async () => {
    if (!revoking) return
    setBusy(true); setActionError(undefined)
    const r = await api.revokeToken(revoking.id)
    setBusy(false); setRevoking(null)
    if (r.kind === 'error') { if (r.status !== 404) return setActionError(r.error); setActionError('Already revoked.') }
    reload()
  }

  return (
    <AccountShell>
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-[32px] leading-12 font-bold">API tokens</h1>
          <p className="text-sm text-muted-foreground">
            <code className="font-mono text-[13px]">insta_</code> keys for the CLI, MCP and agents. Revoking one breaks whatever uses it immediately.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <TokenCreate apiUrl={apiUrl} defaultName="" showExpiry onCreated={reload} />
        </div>

        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="px-4 py-3 text-left text-[13px] font-normal text-muted-foreground">Name</th>
                <th className="px-4 py-3 text-left text-[13px] font-normal text-muted-foreground">Key</th>
                <th className="px-4 py-3 text-left text-[13px] font-normal text-muted-foreground">Created</th>
                <th className="px-4 py-3 text-left text-[13px] font-normal text-muted-foreground">Last used</th>
                <th className="px-4 py-3 text-left text-[13px] font-normal text-muted-foreground">Expires</th>
                <th className="w-12" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-2"><KeyRound className="size-4" /> {error ? error.message : 'No tokens yet.'}</span>
                  </td>
                </tr>
              ) : rows.map((t) => (
                <tr key={t.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2.5 text-sm font-medium">{t.name}</td>
                  <td className="px-4 py-2.5 font-mono text-[13px] text-muted-foreground">{t.prefix}{'•'.repeat(8)}</td>
                  <td className="px-4 py-2.5 text-[13px] text-muted-foreground" title={t.createdAt}>{relTime(t.createdAt)}</td>
                  <td className="px-4 py-2.5 text-[13px] text-muted-foreground" title={t.lastUsedAt ?? undefined}>{t.lastUsedAt ? relTime(t.lastUsedAt) : 'never'}</td>
                  <td className="px-4 py-2.5 text-[13px] text-muted-foreground">{fmtDate(t.expiresAt)}</td>
                  <td className="px-2 py-2.5 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${t.name}`}>
                          <EllipsisVertical className="size-4 text-muted-foreground" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setRevoking(t)}>Revoke</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ErrorNote error={actionError} />
      </div>
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke token"
        description={`Revoking ${revoking?.name ?? 'this token'} immediately breaks anything using it.`}
        confirmText="Revoke"
        destructive
        isLoading={busy}
        onConfirm={revoke}
      />
    </AccountShell>
  )
}
