import { Outlet, NavLink, Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { usePoll } from '../hooks'
import { Chip } from './ui'

function Crumb({ children }: { children: React.ReactNode }) {
  return <span className="flex items-center gap-1 text-sm text-neutral-700">{children}</span>
}

function Picker({ value, options, onPick }: { value: string; options: { key: string; label: string }[]; onPick: (k: string) => void }) {
  return (
    <select
      className="cursor-pointer appearance-none rounded-md bg-transparent py-1 pr-5 text-sm font-medium text-neutral-800 hover:bg-neutral-100"
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
    <header className="flex h-12 items-center justify-between border-b border-neutral-200 bg-neutral-50 px-4">
      <div className="flex items-center gap-2">
        <Link to="/" className="mr-1 text-lg" title="insta-oss">⚡</Link>
        <Crumb>local</Crumb>
        <span className="text-neutral-300">/</span>
        <Picker
          value={projectId ?? ''}
          options={(projects ?? (project ? [project] : [])).map((p) => ({ key: p.id, label: p.name }))}
          onPick={(id) => nav(`/p/${id}/main/services`)}
        />
        <span className="text-neutral-300">/</span>
        <Picker
          value={branch ?? ''}
          options={(branches ?? []).map((b) => ({ key: b.name, label: b.name }))}
          onPick={(b) => nav(`/p/${projectId}/${b}/services`)}
        />
      </div>
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1.5 text-xs text-neutral-500" title="instad daemon">
          <span className={`h-1.5 w-1.5 rounded-full ${health?.ok ? 'bg-green-500' : 'bg-red-500'}`} />
          daemon
        </span>
        <a href="https://github.com/InsForge/insta-oss#readme" target="_blank" rel="noreferrer"
          className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100">
          Docs
        </a>
      </div>
    </header>
  )
}

function SideItem({ to, label, glyph, badge }: { to: string; label: string; glyph: string; badge?: number }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-600 hover:bg-neutral-200/60'}`}
    >
      <span className="w-4 text-center text-[13px] opacity-70">{glyph}</span>
      {label}
      {badge ? (
        <span className="ml-auto rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white">{badge}</span>
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
    <aside className="flex w-56 shrink-0 flex-col border-r border-neutral-200 bg-neutral-100">
      <nav className="flex-1 space-y-0.5 p-2">
        <SideItem to={`${base}/usage`} label="Usage" glyph="◫" />
        <SideItem to={`${base}/branches`} label="Branches" glyph="⑂" />
        <SideItem to={`${base}/approvals`} label="Approvals" glyph="⚖" badge={pending} />
        <div className="px-3 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wide text-neutral-400">Branch</div>
        <div className="flex items-center gap-2 px-3 py-1.5 text-sm text-neutral-800">
          <span className="w-4 text-center text-[13px] opacity-70">⑂</span>
          <span className="font-medium">{branch}</span>
          {isDefault && <Chip>Production</Chip>}
        </div>
        <SideItem to={`${base}/services`} label="Service" glyph="❖" />
        <SideItem to={`${base}/logs`} label="Logs" glyph="≡" />
      </nav>
      <div className="border-t border-neutral-200 p-2">
        <SideItem to={`${base}/settings`} label="Settings" glyph="⚙" />
      </div>
    </aside>
  )
}

export function Layout() {
  return (
    <div className="flex h-screen flex-col bg-white text-neutral-900">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <SideBar />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
