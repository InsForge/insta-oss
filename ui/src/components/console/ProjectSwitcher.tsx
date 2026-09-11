// The console's project switcher (insta-frontend components/project/project-switcher.tsx): the
// sidebar header is two hit areas, the logo cell (back to all projects) and the name + chevron
// (the project dropdown). With the rail collapsed the dropdown moves into the topbar as a 240px
// cell. Self-host divergence: there is no projects gallery or in-app project create (a project is
// made with `insta project create`), so the menu lists projects only.

import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@insforge/ui'
import { Check, ChevronDown } from 'lucide-react'
import { api } from '../../api'
import { usePoll } from '../../hooks'
import { InstaCloudMark } from './BrandMark'
import { useSidebarCollapsed } from './AppSidebar'

function useProjects() {
  // Chrome data changes rarely.
  return usePoll(api.projects, [], 30_000).data
}

function ProjectSwitcherMenu({ projectId, trigger }: { projectId: string; trigger: ReactNode }) {
  const nav = useNavigate()
  const projects = useProjects() ?? []
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <div className="max-h-78 overflow-y-auto">
          {projects.map((project) => {
            const current = project.id === projectId
            return (
              <DropdownMenuItem key={project.id} onSelect={() => { if (!current) nav(`/p/${project.id}`) }}>
                <Check className={current ? 'size-4 shrink-0' : 'invisible size-4 shrink-0'} />
                <span className="truncate">{project.name}</span>
              </DropdownMenuItem>
            )
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ProjectSwitcher({ projectId }: { projectId: string }) {
  const [collapsed] = useSidebarCollapsed()
  const name = useProjects()?.find((p) => p.id === projectId)?.name ?? ''
  return (
    <div className="flex h-12 w-60 shrink-0 items-center border-b border-border transition-colors has-[[data-state=open]]:bg-alpha-8 has-[button:hover]:bg-alpha-4">
      <Link to="/" title="All Projects" aria-label="All Projects"
        className="group/logo flex h-full w-12 shrink-0 items-center justify-center outline-hidden">
        <span className="flex size-8 items-center justify-center transition-colors group-hover/logo:bg-alpha-8 group-focus-visible/logo:bg-alpha-8">
          <InstaCloudMark className="h-[19px] w-6 text-foreground" />
        </span>
      </Link>
      <ProjectSwitcherMenu
        projectId={projectId}
        trigger={
          <button type="button"
            className={cn('flex h-full min-w-0 flex-1 items-center text-left outline-hidden transition-colors focus-visible:bg-alpha-8',
              collapsed && 'pointer-events-none')}>
            <span className={cn('min-w-0 flex-1 truncate text-sm transition-opacity duration-200', collapsed && 'opacity-0')}>{name}</span>
            <ChevronDown className={cn('mr-3 size-4 shrink-0 text-muted-foreground transition-opacity duration-200', collapsed && 'opacity-0')} />
          </button>
        }
      />
    </div>
  )
}

/** The collapsed-rail stand-in: renders nothing while the sidebar is expanded. */
export function TopbarProjectSwitcher({ projectId }: { projectId: string }) {
  const [collapsed] = useSidebarCollapsed()
  const name = useProjects()?.find((p) => p.id === projectId)?.name ?? ''
  if (!collapsed) return null
  return (
    <ProjectSwitcherMenu
      projectId={projectId}
      trigger={
        <button type="button"
          className="flex h-full w-60 shrink-0 items-center gap-2 border-r border-border px-3 text-left outline-hidden transition-colors hover:bg-alpha-4 focus-visible:bg-alpha-8 data-[state=open]:bg-alpha-8">
          <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
          <ChevronDown className="size-5 shrink-0 text-muted-foreground" />
        </button>
      }
    />
  )
}
