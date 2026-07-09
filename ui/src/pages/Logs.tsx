import { useParams } from 'react-router-dom'
import { api } from '../api'
import { usePoll } from '../hooks'

/** Logs land with the docker-backed observability endpoints (roadmap Phase 2). Until the daemon
 *  serves them this page states that honestly instead of faking data. */
export function Logs() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  const { data, error } = usePoll(() => api.logs(projectId, 'compute'), [projectId], 60000)

  if (!data) {
    return (
      <div className="mx-auto flex w-full max-w-[64rem] flex-col gap-4">
        <h1 className="text-[32px] leading-12 font-bold">Logs</h1>
        <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
          <p className="text-sm font-medium">Coming with the docker-backed observability phase</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {error && 'status' in error && (error as { status?: number }).status === 501
              ? 'The daemon will tail this environment\'s containers via docker logs — same response shape as the cloud.'
              : error?.message}
          </p>
          <p className="mt-4 font-mono text-xs text-muted-foreground">
            meanwhile: docker logs io-&lt;project&gt;-{branch}-app-&lt;group&gt;
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="mx-auto flex w-full max-w-[64rem] flex-col gap-4">
      <h1 className="text-[32px] leading-12 font-bold">Logs</h1>
      <pre className="overflow-x-auto rounded-lg bg-semantic-6 p-4 text-xs text-inverse">{JSON.stringify(data, null, 2)}</pre>
    </div>
  )
}
