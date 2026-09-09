import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { Button, Input } from '@insforge/ui'
import { Zap } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../components/AuthGate'
import { TokenCreate } from '../components/TokenCreate'
import { ErrorNote } from '../components/ui'
import { apiUrlForCli } from '../lib/apiUrl'

/** Centered card shared by Setup and Login (the console's AuthShell, without OAuth). */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-semantic-0 px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-md bg-foreground text-inverse"><Zap className="size-4" /></span>
          <span className="text-sm font-bold">insta-oss</span>
        </div>
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </div>
  )
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  )
}

/** First visit in server mode: create the admin, then (optionally) mint the first CLI token. */
export function Setup() {
  const auth = useAuth()
  const nav = useNavigate()
  const [step, setStep] = useState<'form' | 'token'>('form')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [exists, setExists] = useState(false)

  if (auth.mode !== 'server') return <Navigate to="/" replace />
  if (step === 'form' && !auth.setupRequired) return <Navigate to="/" replace />

  const valid = email.includes('@') && password.length >= 8 && confirm === password
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!valid) return
    setBusy(true); setError(undefined); setExists(false)
    const r = await api.signUp(name.trim() ? { name: name.trim(), email: email.trim(), password } : { email: email.trim(), password })
    setBusy(false)
    if (r.kind === 'error') {
      if (r.status === 422) { setExists(true); return setError('An admin already exists. Sign in instead.') }
      return setError(r.error)
    }
    if (r.kind === 'approval') return setError('unexpected approval envelope on sign-up')
    await auth.refresh()
    setStep('token')
  }

  const apiUrl = auth.boot.apiUrl || apiUrlForCli(location.origin)

  if (step === 'token') {
    return (
      <AuthShell title="Create a CLI token" subtitle="Optional. You can also mint keys later under Account, API tokens.">
        <TokenCreate apiUrl={apiUrl} defaultName="laptop" />
        <div className="mt-5 flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="secondary" onClick={() => nav('/')}>Skip</Button>
          <Button variant="primary" onClick={() => nav('/')}>Open dashboard</Button>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Set up this daemon" subtitle="Create the admin account. One admin owns this install.">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field label="Name (optional)">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada" autoComplete="name" />
        </Field>
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="username" required />
        </Field>
        <Field label="Password">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={8} />
          <p className="mt-1 text-xs text-muted-foreground">At least 8 characters.</p>
        </Field>
        <Field label="Confirm password">
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          {confirm && confirm !== password && <p className="mt-1 text-xs text-destructive">Passwords do not match.</p>}
        </Field>
        <ErrorNote error={error} />
        {exists && <Link to="/login" className="text-sm font-medium underline">Go to sign in</Link>}
        <Button type="submit" variant="primary" disabled={!valid || busy} className="mt-1">
          {busy ? 'Creating' : 'Create admin'}
        </Button>
      </form>
    </AuthShell>
  )
}
