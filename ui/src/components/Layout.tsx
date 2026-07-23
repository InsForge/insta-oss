import { Outlet, NavLink, Link, useNavigate, useParams } from 'react-router-dom'
import { cn } from '@insforge/ui'
import {
  Box,
  ChartColumn,
  Database,
  GitBranch,
  History,
  KeyRound,
  ScrollText,
  Settings,
  ShieldCheck,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { api } from '../api'
import { usePoll } from '../hooks'
import { Chip } from './ui'

function Picker({ value, options, onPick }: { value: string; options: { key: string; label: string }[]; onPick: (k: string) => void }) {
  return (
    <select
      className="cursor-pointer appearance-none rounded-md bg-transparent py-1 pr-5 text-sm font-medium text-foreground hover:bg-alpha-4"
      style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2710%27 height=%276%27%3E%3Cpath d=%27M1 1l4 4 4-4%27 stroke=%27%23737373%27 fill=%27none%27/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 4px center', paddingLeft: 6 }}
      value={value}
      onChange={(e) => onPick(e.target.value)}
    >
      {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
    </select>
  )
}

function TopBar() {
  const { projectId, branch } = useParams()
  const nav = useNavigate()
  const { data: projects } = usePoll(api.projects, [])
  const { data: branches } = usePoll(() => api.branches(projectId!), [projectId])
  const { data: health } = usePoll(api.health, [], 10000)
  const project = projects?.find((p) => p.id === projectId)

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">local</span>
        <span className="text-border">/</span>
        <Picker
          value={projectId ?? ''}
          options={(projects ?? (project ? [project] : [])).map((p) => ({ key: p.id, label: p.name }))}
          onPick={(id) => nav(`/p/${id}/main/services`)}
        />
        <span className="text-border">/</span>
        <Picker
          value={branch ?? ''}
          options={(branches ?? []).map((b) => ({ key: b.name, label: b.name }))}
          onPick={(b) => nav(`/p/${projectId}/${b}/services`)}
        />
      </div>
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title="instad daemon">
          <span className={cn('size-1.5 rounded-full', health?.ok ? 'bg-success' : 'bg-destructive')} />
          daemon
        </span>
        <a href="https://github.com/InsForge/insta-oss#readme" target="_blank" rel="noreferrer"
          className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-alpha-4 hover:text-foreground">
          Docs
        </a>
      </div>
    </header>
  )
}

function SideItem({ to, label, icon: Icon, badge }: { to: string; label: string; icon: LucideIcon; badge?: number }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'flex h-10 items-center gap-3 pr-3 pl-3.5 text-sm transition-colors',
          isActive
            ? 'bg-alpha-8 font-medium text-foreground'
            : 'text-muted-foreground hover:bg-alpha-4 hover:text-foreground',
        )}
    >
      <Icon className="size-5 shrink-0" />
      {label}
      {badge ? (
        <span className="ml-auto rounded-full bg-warning px-1.5 text-[11px] font-semibold text-inverse">{badge}</span>
      ) : null}
    </NavLink>
  )
}

function SideBar() {
  const { projectId, branch } = useParams()
  const { data: branches } = usePoll(() => api.branches(projectId!), [projectId])
  const { data: approvals } = usePoll(() => api.approvals(projectId!), [projectId])
  const base = `/p/${projectId}/${branch}`
  const isDefault = branches?.find((b) => b.name === branch)?.is_default
  const pending = approvals?.filter((a) => a.status === 'pending').length ?? 0

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-semantic-1">
      <Link
        to="/"
        className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2.5 transition-colors hover:bg-alpha-4"
        title="insta-oss"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground text-inverse">
          <Zap className="size-4" />
        </span>
        <span className="flex-1 truncate text-sm font-bold">insta-oss</span>
      </Link>
      <nav className="flex flex-1 flex-col py-2">
        <SideItem to={`${base}/usage`} label="Usage" icon={ChartColumn} />
        <SideItem to={`${base}/env`} label="Environments" icon={GitBranch} />
        <SideItem to={`${base}/approvals`} label="Approvals" icon={ShieldCheck} badge={pending} />
        <SideItem to={`${base}/operations`} label="Operations" icon={History} />
        <div className="my-2 border-t border-border" />
        <div className="flex h-10 items-center gap-3 pr-3 pl-3.5 text-sm">
          <GitBranch className="size-5 shrink-0 text-muted-foreground" />
          <span className="font-medium">{branch}</span>
          {isDefault && <Chip>Prod</Chip>}
        </div>
        <SideItem to={`${base}/services`} label="Service" icon={Box} />
        <SideItem to={`${base}/secrets`} label="Secrets" icon={KeyRound} />
        <SideItem to={`${base}/database`} label="Database" icon={Database} />
        <SideItem to={`${base}/logs`} label="Logs" icon={ScrollText} />
      </nav>
      <div className="border-t border-border py-2">
        <SideItem to={`${base}/settings`} label="Settings" icon={Settings} />
      </div>
    </aside>
  )
}

export function Layout() {
  return (
    <div className="flex h-screen">
      <SideBar />
      <div className="flex min-w-0 flex-1 flex-col bg-semantic-0">
        <TopBar />
        <main className="min-w-0 flex-1 overflow-y-auto px-8 pt-8 pb-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
