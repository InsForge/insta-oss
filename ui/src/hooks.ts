import { useCallback, useEffect, useRef, useState } from 'react'

/** Poll a fetcher on an interval (default 5s — the daemon is local). */
export function usePoll<T>(fn: () => Promise<T>, deps: unknown[], intervalMs = 5000): {
  data: T | undefined; error: Error | undefined; reload: () => void
} {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<Error>()
  const [tick, setTick] = useState(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    let timer: ReturnType<typeof setTimeout>
    const run = async () => {
      try {
        const d = await fn()
        if (alive.current) { setData(d); setError(undefined) }
      } catch (e) {
        if (alive.current) setError(e as Error)
      }
      if (alive.current) timer = setTimeout(run, intervalMs)
    }
    void run()
    return () => { alive.current = false; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, intervalMs])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, reload }
}
