import { useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { Button, Input } from '@insforge/ui'
import { api } from '../api'
import { safeNext, useAuth } from '../components/AuthGate'
import { ErrorNote } from '../components/ui'
import { AuthShell, Field } from './Setup'

export function Login() {
  const auth = useAuth()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  if (auth.mode !== 'server') return <Navigate to="/" replace />
  if (auth.user) return <Navigate to={safeNext(params.get('next'))} replace />

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!email.trim() || !password) return
    setBusy(true); setError(undefined)
    const r = await api.signIn({ email: email.trim(), password })
    setBusy(false)
    if (r.kind === 'error') {
      if (r.status === 401) return setError('Wrong email or password.')
      if (r.status === 429) return setError('Too many attempts; try again later.')
      return setError(r.error)
    }
    if (r.kind === 'approval') return setError('unexpected approval envelope on sign-in')
    await auth.refresh()
    nav(safeNext(params.get('next')), { replace: true })
  }

  return (
    <AuthShell title="Sign in" subtitle="The admin account for this daemon.">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field label="Email">
          <Input autoFocus type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="username" required />
        </Field>
        <Field label="Password">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        <ErrorNote error={error} />
        <Button type="submit" variant="primary" disabled={busy || !email.trim() || !password} className="mt-1">
          {busy ? 'Signing in' : 'Sign in'}
        </Button>
        {auth.setupRequired && (
          <p className="text-center text-xs text-muted-foreground">
            First run? <Link to="/setup" className="font-medium underline">Create the admin</Link>
          </p>
        )}
      </form>
    </AuthShell>
  )
}
