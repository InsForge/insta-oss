import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { api } from './api'
import { usePoll } from './hooks'
import { Layout } from './components/Layout'
import { Services } from './pages/Services'
import { Environments } from './pages/Environments'
import { Logs } from './pages/Logs'
import { Usage } from './pages/Usage'
import { Approvals } from './pages/Approvals'
import { Settings } from './pages/Settings'

/** Lands on the first project's default branch (or an empty state if none exist yet). */
function Home() {
  const { data: projects, error } = usePoll(api.projects, [])
  if (error) return <CenterNote title="daemon unreachable" body="Is instad running? Start it with: npm run dev" />
  if (!projects) return null
  if (!projects.length) {
    return <CenterNote title="No projects yet" body="Create one and it appears here: insta project create <name>" />
  }
  return <ProjectRedirect projectId={projects[0].id} />
}

function ProjectRedirect({ projectId }: { projectId: string }) {
  const { data: branches } = usePoll(() => api.branches(projectId), [projectId])
  if (!branches) return null
  const def = branches.find((b) => b.is_default) ?? branches[0]
  return <Navigate to={`/p/${projectId}/${def?.name ?? 'main'}/services`} replace />
}

function CenterNote({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-screen items-center justify-center bg-white">
      <div className="text-center">
        <h1 className="text-xl font-semibold text-neutral-800">{title}</h1>
        <p className="mt-2 font-mono text-sm text-neutral-500">{body}</p>
      </div>
    </div>
  )
}

function ProjectShell() {
  const { projectId } = useParams()
  if (!projectId) return <Navigate to="/" replace />
  return <Layout />
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/p/:projectId/:branch" element={<ProjectShell />}>
        <Route index element={<Navigate to="services" replace />} />
        <Route path="services" element={<Services />} />
        <Route path="env" element={<Environments />} />
        {/* pre-rename bookmarks */}
        <Route path="branches" element={<Navigate to="../env" replace />} />
        <Route path="logs" element={<Logs />} />
        <Route path="usage" element={<Usage />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
