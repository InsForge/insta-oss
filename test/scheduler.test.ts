// The scheduler over FakeRuntime and fake timers (contract 00 sections 8.3 and 13, plan 03).
// Nothing here touches docker or the engine: the Scheduler takes a Runtime, a Config, a targets
// function, two hooks and an Upstream, which is exactly what makes the sweep, the wake doors, the
// operation lock and eviction testable without containers.
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  NoContainerError, Scheduler, ServiceStoppedError, WakeTimeoutError,
  type ServiceTarget, type SleepReason, type WakeDoor,
} from '../src/scheduler'
import type { ServiceKey } from '../src/types'
import { calls, FakeRuntime, FakeUpstream, fakeTarget, testConfig } from './fakes'

const MiB = 1024 * 1024

interface Harness {
  sched: Scheduler
  runtime: FakeRuntime
  upstream: FakeUpstream
  targets: Map<ServiceKey, ServiceTarget>
  slept: Array<[ServiceKey, number | null]>
  events: Array<{ key: ServiceKey; kind: string; payload: Record<string, unknown> }>
  add(key: ServiceKey, over?: Partial<ServiceTarget>): ServiceTarget
  setBooting(v: boolean): void
}

/** One scheduler with its own runtime, upstream and target table. `add` both registers a target and
 *  puts its container in the store, because that is the shape every real code path sees. */
function harness(env: Record<string, string> = {}): Harness {
  const runtime = new FakeRuntime()
  const upstream = new FakeUpstream(runtime)
  const targets = new Map<ServiceKey, ServiceTarget>()
  const slept: Array<[ServiceKey, number | null]> = []
  const events: Array<{ key: ServiceKey; kind: string; payload: Record<string, unknown> }> = []
  let booting = false
  const sched = new Scheduler(
    runtime, testConfig(env), () => [...targets.values()],
    {
      markSlept: (key, at) => {
        slept.push([key, at])
        const t = targets.get(key)
        if (t) t.sleptAt = at
      },
      emit: (key, kind, payload) => { events.push({ key, kind, payload }) },
      booting: () => booting,
    },
    upstream,
  )
  return {
    sched, runtime, upstream, targets, slept, events,
    add(key, over = {}) {
      const t = fakeTarget({ key, ...over })
      targets.set(key, t)
      runtime.put(t.container, over.sleptAt ? 'exited' : 'running')
      sched.register(key)
      return t
    },
    setBooting(v) { booting = v },
  }
}

const K = '11111111-1111-1111-1111-111111111111:cp-web'
const K2 = '11111111-1111-1111-1111-111111111111:cp-api'
const PG = '11111111-1111-1111-1111-111111111111:pg-db'

beforeEach(() => { calls.length = 0; vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

// ---- the sweep -----------------------------------------------------------------------------------

test('sweep table: each of running, alwaysOn, desiredState, stamp age, create grace and in-flight flips the outcome on its own', async () => {
  const h = harness()
  const t = h.add(K)
  // Baseline: idle past the window, nothing else in the way.
  vi.advanceTimersByTime(301_000)
  await h.sched.sweep()
  expect(calls).toContain(`runtime.stop:${t.container}:10`)

  // ...and now each veto in turn, each from that same baseline in its own harness.
  const vetoes: Array<[string, (h: Harness, t: ServiceTarget) => void]> = [
    ['not running', (fresh, target) => { fresh.runtime.put(target.container, 'exited') }],
    ['alwaysOn', (_fresh, target) => { target.alwaysOn = true }],
    ['user-stopped', (_fresh, target) => { target.desiredState = 'stopped' }],
    ['idle window disabled', (_fresh, target) => { target.idleSec = 0 }],
    ['inside the create grace', (_fresh, target) => { target.createdAt = Date.now() - 60_000 }],
    ['freshly stamped', (fresh) => { fresh.sched.touch(K) }],
  ]
  for (const [name, veto] of vetoes) {
    const fresh = harness()
    const target = fresh.add(K)
    vi.advanceTimersByTime(301_000)
    veto(fresh, target)
    calls.length = 0
    await fresh.sched.sweep()
    expect(calls.filter((c) => c.startsWith('runtime.stop:')), name).toEqual([])
  }
  expect(t.sleptAt).toBeTypeOf('number')      // the baseline above really did sleep
})

test('an operation in flight on the key makes it no sweep candidate, and sleep refuses without queueing', async () => {
  const h = harness()
  const t = h.add(K)
  vi.advanceTimersByTime(301_000)
  let release = (): void => {}
  const held = new Promise<void>((r) => { release = () => { r() } })
  const op = h.sched.withOp([K], () => held)
  await h.sched.sweep()
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
  // tryWithOp refuses rather than lining up behind the op (a stop that ran later would stop the
  // container the op had just created).
  expect(await h.sched.sleep(K, 'idle')).toBe(false)
  release()
  await op
  await h.sched.sweep()
  expect(calls).toContain(`runtime.stop:${t.container}:10`)
})

test('windows: compute 300 s, databases 600 s, a per-database override, and 0 disables', async () => {
  const h = harness()
  const web = h.add(K)
  const pg = h.add(PG, { kind: 'postgres', container: 'io-demo-main-pg-db', port: 5432, idleSec: 600 })
  const never = h.add(K2, { idleSec: 0 })
  vi.advanceTimersByTime(301_000)
  await h.sched.sweep()
  expect(calls).toContain(`runtime.stop:${web.container}:10`)          // compute window passed
  expect(calls).not.toContain(`runtime.stop:${pg.container}:30`)       // the database's has not
  vi.advanceTimersByTime(300_000)
  await h.sched.sweep()
  expect(calls).toContain(`runtime.stop:${pg.container}:30`)           // databases get the long grace
  expect(calls.some((c) => c.startsWith(`runtime.stop:${never.container}`))).toBe(false)
})

test('a service sleeps between 300 and 330 s after its last stamp, and touch restarts the clock', async () => {
  const h = harness({ INSTA_OSS_SWEEP_SEC: '30' })
  const t = h.add(K)
  vi.advanceTimersByTime(299_000)
  await h.sched.sweep()
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
  h.sched.touch(K)                                    // one request lands: the window starts over
  vi.advanceTimersByTime(299_000)
  await h.sched.sweep()
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
  vi.advanceTimersByTime(2_000)
  await h.sched.sweep()
  expect(calls).toContain(`runtime.stop:${t.container}:10`)
})

test('sleep stamps sleptAt, emits service.sleep with the BARE service id, and leaves desiredState alone', async () => {
  const h = harness()
  const t = h.add(K)
  expect(await h.sched.sleep(K, 'idle')).toBe(true)
  expect(h.slept.at(-1)?.[0]).toBe(K)
  expect(typeof h.slept.at(-1)?.[1]).toBe('number')
  expect(h.events).toEqual([{ key: K, kind: 'service.sleep', payload: { service: 'cp-web', reason: 'idle' } }])
  expect(t.desiredState).toBe('running')
  expect(calls).toContain(`upstream.forget:${t.container}`)
})

test('sleep on a created container marks it asleep without a docker stop; a paused one is refused', async () => {
  const h = harness()
  const t = h.add(K)
  h.runtime.put(t.container, 'created')
  expect(await h.sched.sleep(K, 'branch-create')).toBe(true)
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
  expect(h.slept.at(-1)?.[1]).toBeTypeOf('number')

  h.runtime.put(t.container, 'paused')
  h.slept.length = 0
  expect(await h.sched.sleep(K, 'idle')).toBe(false)
  expect(h.slept).toEqual([])
})

test('onUp stamps, clears sleptAt through markSlept and drops the cached address', async () => {
  const h = harness()
  const t = h.add(K, { sleptAt: 123 })
  h.sched.onUp(K)
  expect(h.slept).toEqual([[K, null]])
  expect(calls).toContain(`upstream.forget:${t.container}`)
  expect(h.sched.stateOf(K)).toBe('running')
})

test('a user stop clears the sleep mark (a stop is not sleep) and a pause records paused', async () => {
  const h = harness()
  h.add(K, { sleptAt: 5 })
  h.sched.onStopped(K)
  expect(h.slept).toEqual([[K, null]])
  expect(h.sched.stateOf(K)).toBe('stopped')
  h.sched.onPaused(K)
  expect(h.sched.stateOf(K)).toBe('paused')
})

test('the sweep tells the upstream about a container whose id changed between ticks', async () => {
  const h = harness()
  const t = h.add(K)
  await h.sched.sweep()
  expect(calls).toContain(`upstream.checked:${t.container}:cid1`)
  h.runtime.replace(t.container, 'running')            // restarted by itself: same name, new id
  calls.length = 0
  await h.sched.sweep()
  expect(calls.some((c) => c.startsWith(`upstream.checked:${t.container}:`) && !c.endsWith(':cid1'))).toBe(true)
})

test('the sweep is inert while the boot data migration runs', async () => {
  const h = harness()
  h.add(K)
  h.setBooting(true)
  vi.advanceTimersByTime(301_000)
  await h.sched.sweep()
  expect(calls).toEqual([])
  h.setBooting(false)
  await h.sched.sweep()
  expect(calls.some((c) => c.startsWith('runtime.stop:'))).toBe(true)
})

// ---- boot ----------------------------------------------------------------------------------------

test('boot reconcile: a running container with a sleep mark is cleared, unknown keys get a full window', async () => {
  const h = harness({ INSTA_OSS_SCHEDULER: '0' })
  const t = h.add(K, { sleptAt: 999 })
  h.runtime.put(t.container, 'running')                // it came back up on its own
  h.sched.start()
  await vi.runOnlyPendingTimersAsync()
  expect(h.slept).toEqual([[K, null]])
  expect(h.sched.stateOf(K)).toBe('running')
  // ...and the fresh stamp means it is not swept for a full idle window after the restart.
  vi.advanceTimersByTime(299_000)
  await h.sched.sweep()
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
})

test('the create grace comes from the ROW, so a restart does not grant a fresh one', async () => {
  const h = harness({ INSTA_OSS_SCHEDULER: '0' })
  const old = h.add(K, { createdAt: Date.now() - 20 * 60_000 })   // created 20 min ago
  const young = h.add(K2, { createdAt: Date.now() - 60_000 })     // created 1 min ago
  h.sched.start()
  await vi.runOnlyPendingTimersAsync()
  vi.advanceTimersByTime(301_000)                                 // ONE idle window after the boot
  await h.sched.sweep()
  expect(calls).toContain(`runtime.stop:${old.container}:10`)
  expect(calls.some((c) => c.startsWith(`runtime.stop:${young.container}`))).toBe(false)
})

test('boot performs no eviction: nothing is stopped below the floor until the first sweep tick', async () => {
  const h = harness({ INSTA_OSS_SCHEDULER: '0', INSTA_OSS_RAM_FLOOR_PCT: '15' })
  const t = h.add(K)
  h.runtime.mem = { totalBytes: 1000 * MiB, availableBytes: 10 * MiB }   // far below the floor
  h.sched.start()
  await vi.runOnlyPendingTimersAsync()
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
  // The first sweep is where the pressure pass lives.
  vi.advanceTimersByTime(4 * h.sched['cfg'].lanes.touchDebounceMs)
  await h.sched.sweep()
  expect(calls).toContain(`runtime.stop:${t.container}:10`)
})

// ---- wake ----------------------------------------------------------------------------------------

test('wake singleflight: 25 concurrent calls share one docker start and all resolve', async () => {
  const h = harness()
  const t = h.add(K)
  h.runtime.put(t.container, 'exited')
  let ready = false
  h.runtime.probeFn = () => ready
  const all = Promise.all(Array.from({ length: 25 }, () => h.sched.wake(K, { door: 'traffic' })))
  await vi.advanceTimersByTimeAsync(300)
  expect(calls.filter((c) => c === `runtime.start:${t.container}`)).toHaveLength(1)
  expect(h.sched.stateOf(K)).toBe('starting')
  ready = true
  await vi.advanceTimersByTimeAsync(300)
  await all
  expect(h.sched.stateOf(K)).toBe('running')
  expect(h.slept.at(-1)).toEqual([K, null])
  expect(h.events.at(-1)?.kind).toBe('service.wake')
  expect(h.events.at(-1)?.payload.service).toBe('cp-web')
  expect(h.events.at(-1)?.payload.door).toBe('traffic')
})

test('traffic never wakes a service the developer stopped or suspended; the api door proceeds', async () => {
  for (const desiredState of ['stopped', 'suspended'] as const) {
    calls.length = 0
    const h = harness()
    const t = h.add(K, { desiredState })
    h.runtime.put(t.container, 'exited')
    await expect(h.sched.wake(K, { door: 'traffic' })).rejects.toBeInstanceOf(ServiceStoppedError)
    expect(calls.filter((c) => c.startsWith('runtime.start:'))).toEqual([])
    await h.sched.wake(K, { door: 'api' })
    expect(calls).toContain(`runtime.start:${t.container}`)
  }
})

test('a wake that never becomes ready is a WakeTimeoutError, the container is left running and the sleep mark untouched', async () => {
  const h = harness({ INSTA_OSS_WAKE_TIMEOUT_SEC: '2' })
  const t = h.add(K, { sleptAt: 7 })
  h.runtime.put(t.container, 'exited')
  h.runtime.probeFn = () => false
  const p = h.sched.wake(K, { door: 'api' })
  const settled = expect(p).rejects.toBeInstanceOf(WakeTimeoutError)
  await vi.advanceTimersByTimeAsync(3_000)
  await settled
  expect(h.runtime.stateOfContainer(t.container)).toBe('running')       // never rolled back
  expect(h.slept).toEqual([])                                          // sleptAt is still 7
  expect(h.sched.stateOf(K)).toBe('asleep')
})

test('a container that exits mid-wake ends the wake with an error, not a timeout', async () => {
  const h = harness({ INSTA_OSS_WAKE_TIMEOUT_SEC: '60' })
  const t = h.add(K)
  h.runtime.put(t.container, 'exited')
  h.runtime.probeFn = () => false
  const p = h.sched.wake(K, { door: 'api' })
  const settled = expect(p).rejects.toThrow(/exited during wake/)
  await vi.advanceTimersByTimeAsync(300)
  h.runtime.put(t.container, 'exited')                                 // it died on start-up
  await vi.advanceTimersByTimeAsync(600)
  await settled
})

test('a key with no container after the lock is taken throws NoContainerError and never starts anything', async () => {
  const h = harness()
  const t = h.add(K)
  h.runtime.drop(t.container)                                          // a deploy is between rm and create
  await expect(h.sched.wake(K, { door: 'api' })).rejects.toBeInstanceOf(NoContainerError)
  expect(calls.filter((c) => c.startsWith('runtime.start:'))).toEqual([])
})

test('a wake onto a running, ready container is a no-op that only stamps', async () => {
  const h = harness()
  h.add(K, { sleptAt: 42 })
  h.runtime.put(fakeTarget({ key: K }).container, 'running')
  await h.sched.wake(K, { door: 'deploy' })
  expect(calls.filter((c) => c.startsWith('runtime.start:'))).toEqual([])
  expect(h.slept).toEqual([[K, null]])                                 // the stale mark is cleared
  expect(h.events).toEqual([])                                         // no event for a no-op wake
})

test('the api door unpauses a paused container; traffic gets the suspended error instead', async () => {
  const h = harness()
  const t = h.add(K)
  h.runtime.put(t.container, 'paused')
  await expect(h.sched.wake(K, { door: 'traffic' })).rejects.toThrow(/suspended/)
  await h.sched.wake(K, { door: 'api' })
  expect(calls).toContain(`runtime.unpause:${t.container}`)
})

test('a wake needing room evicts and starts CONCURRENTLY: the start is issued before the victim stop resolves', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '50' })
  const victim = h.add(K2)
  const waking = h.add(K)
  h.runtime.put(waking.container, 'exited')
  h.runtime.mem = { totalBytes: 1000 * MiB, availableBytes: 100 * MiB }
  await h.sched.sweep()                                       // seed the snapshot; both are known
  calls.length = 0
  vi.advanceTimersByTime(20_000)                              // past the no-recent-traffic guard
  let releaseStop = (): void => {}
  const stopGate = new Promise<void>((r) => { releaseStop = () => { r() } })
  const realStop = h.runtime.stop.bind(h.runtime)
  h.runtime.stop = async (container, grace) => { calls.push(`stop.enter:${container}`); await stopGate; await realStop(container, grace) }
  const p = h.sched.wake(K, { door: 'traffic' })
  await vi.advanceTimersByTimeAsync(50)
  expect(calls).toContain(`stop.enter:${victim.container}`)
  expect(calls).toContain(`runtime.start:${waking.container}`)          // did NOT wait for the stop
  releaseStop()
  await vi.advanceTimersByTimeAsync(50)
  await p
})

test('a wake that arrives during a sleep queues behind the stop and then starts the container', async () => {
  const h = harness()
  const t = h.add(K)
  let releaseStop = (): void => {}
  const stopGate = new Promise<void>((r) => { releaseStop = () => { r() } })
  const realStop = h.runtime.stop.bind(h.runtime)
  h.runtime.stop = async (container, grace) => { await stopGate; await realStop(container, grace) }
  const sleeping = h.sched.sleep(K, 'idle')
  await vi.advanceTimersByTimeAsync(1)
  expect(h.sched.stateOf(K)).toBe('asleep')                             // deterministic while stopping
  const waking = h.sched.wake(K, { door: 'traffic' })
  await vi.advanceTimersByTimeAsync(1)
  expect(calls.filter((c) => c.startsWith('runtime.start:'))).toEqual([])
  releaseStop()
  expect(await sleeping).toBe(true)
  await vi.advanceTimersByTimeAsync(1)
  await waking
  expect(calls.indexOf(`runtime.start:${t.container}`)).toBeGreaterThan(calls.indexOf(`runtime.stop:${t.container}:10`))
  expect(h.sched.stateOf(K)).toBe('running')
})

test('a wake behind an operation re-reads afterwards: no start when the op left it running, a start when it left it created', async () => {
  // The op ends in onUp (a deploy that started the replacement): the wake is a no-op.
  const h = harness()
  const t = h.add(K)
  h.runtime.put(t.container, 'exited')
  let release = (): void => {}
  const gate = new Promise<void>((r) => { release = () => { r() } })
  const op = h.sched.withOp([K], async () => { await gate; h.runtime.put(t.container, 'running'); h.sched.onUp(K) })
  const waking = h.sched.wake(K, { door: 'traffic' })
  await vi.advanceTimersByTimeAsync(1)
  expect(calls.filter((c) => c.startsWith('runtime.start:'))).toEqual([])
  release()
  await op
  await vi.advanceTimersByTimeAsync(1)
  await waking
  expect(calls.filter((c) => c.startsWith('runtime.start:'))).toEqual([])

  // The op ends in a created container (a clone deployed with start:false): the wake starts it.
  const h2 = harness()
  const t2 = h2.add(K)
  let release2 = (): void => {}
  const gate2 = new Promise<void>((r) => { release2 = () => { r() } })
  const op2 = h2.sched.withOp([K], async () => { await gate2; h2.runtime.put(t2.container, 'created'); h2.sched.onAsleep(K, 'branch-create') })
  const waking2 = h2.sched.wake(K, { door: 'traffic' })
  release2()
  await op2
  await vi.advanceTimersByTimeAsync(1)
  await waking2
  expect(calls).toContain(`runtime.start:${t2.container}`)
})

test('an operation arriving during a wake runs only after the wake settles', async () => {
  const h = harness()
  const t = h.add(K)
  h.runtime.put(t.container, 'exited')
  let ready = false
  h.runtime.probeFn = () => ready
  const waking = h.sched.wake(K, { door: 'api' })
  const op = h.sched.withOp([K], async () => { calls.push('op.ran') })
  await vi.advanceTimersByTimeAsync(300)
  expect(calls).not.toContain('op.ran')          // the op is queued behind the wake, not inside it
  ready = true
  await vi.advanceTimersByTimeAsync(300)
  await waking
  await op
  // `upstream.forget` is the wake's last act (onUp), so the op ran strictly after it settled.
  expect(calls.indexOf('op.ran')).toBeGreaterThan(calls.indexOf(`upstream.forget:${t.container}`))
})

// ---- the operation lock --------------------------------------------------------------------------

test('re-entrancy: a wake inside withOp on the same key does not deadlock, and nested multi-key ops run once', async () => {
  const h = harness()
  const t = h.add(K)
  h.runtime.put(t.container, 'exited')
  await h.sched.withOp([K], () => h.sched.wake(K, { door: 'api' }))
  expect(calls).toContain(`runtime.start:${t.container}`)

  let ran = 0
  await h.sched.withOp([K, K2], () => h.sched.withOp([K2], async () => { ran++ }))
  expect(ran).toBe(1)
})

test('two multi-key ops naming the same keys in different orders both complete (sorted acquisition)', async () => {
  const h = harness()
  h.add(K); h.add(K2)
  const order: string[] = []
  const a = h.sched.withOp([K, K2], async () => { order.push('a-in'); await Promise.resolve(); order.push('a-out') })
  const b = h.sched.withOp([K2, K], async () => { order.push('b-in'); order.push('b-out') })
  await Promise.all([a, b])
  expect(order).toEqual(['a-in', 'a-out', 'b-in', 'b-out'])
})

test('the lock is exclusive per key and unrelated keys stay concurrent', async () => {
  const h = harness()
  h.add(K); h.add(K2)
  const order: string[] = []
  let release = (): void => {}
  const gate = new Promise<void>((r) => { release = () => { r() } })
  const first = h.sched.withOp([K], async () => { order.push('first-in'); await gate; order.push('first-out') })
  const second = h.sched.withOp([K], async () => { order.push('second') })
  const other = h.sched.withOp([K2], async () => { order.push('other') })
  await vi.advanceTimersByTimeAsync(1)
  expect(order).toEqual(['first-in', 'other'])       // K2 never waited on K
  release()
  await Promise.all([first, second, other])
  expect(order).toEqual(['first-in', 'other', 'first-out', 'second'])
})

test('a failed operation does not wedge the key', async () => {
  const h = harness()
  h.add(K)
  await expect(h.sched.withOp([K], () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
  let ran = false
  await h.sched.withOp([K], async () => { ran = true })
  expect(ran).toBe(true)
})

// ---- eviction ------------------------------------------------------------------------------------

/** Pressure with a synthetic total: `available` is what the test sets, so the pool decides. */
function pressure(h: Harness, availableMiB: number): void {
  h.runtime.mem = { totalBytes: 1000 * MiB, availableBytes: availableMiB * MiB }
}

test('eviction picks the least recently active service and stops once free memory is back above the floor', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '20' })
  const oldest = h.add(K)
  const newer = h.add(K2)
  await h.sched.sweep()
  calls.length = 0
  vi.advanceTimersByTime(20_000)
  h.sched.touch(K2)                                    // K2 is the busier one
  vi.advanceTimersByTime(20_000)
  pressure(h, 100)
  // Each stop frees 150 MiB in this fake, so ONE eviction is enough.
  const realStop = h.runtime.stop.bind(h.runtime)
  h.runtime.stop = async (c, g) => { await realStop(c, g); pressure(h, 250) }
  await h.sched.evictForRoom(0, new Set())
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([`runtime.stop:${oldest.container}:10`])
  expect(newer.sleptAt).toBeNull()
  expect(h.events.map((e) => e.payload.reason)).toEqual(['memory'])
})

test('a 0 RAM floor disables the pressure pass everywhere: the sweep and a wake both stop nothing', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '0', INSTA_OSS_IDLE_COMPUTE_SEC: '0', INSTA_OSS_IDLE_DB_SEC: '0' })
  const idle = h.add(K)
  const waking = h.add(K2)
  h.runtime.put(waking.container, 'exited')
  await h.sched.sweep()
  pressure(h, 1)                                       // as far under any floor as it gets
  vi.advanceTimersByTime(60_000)
  await h.sched.sweep()
  await h.sched.wake(K2, { door: 'api' })
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
  expect(idle.sleptAt ?? null).toBeNull()
})

test('eviction skips alwaysOn, paused, user-stopped, excluded and not-running services', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '20' })
  const always = h.add('b:cp-always', { alwaysOn: true, container: 'io-x-app-always' })
  const paused = h.add('b:cp-paused', { container: 'io-x-app-paused' })
  const stopped = h.add('b:cp-stopped', { desiredState: 'stopped', container: 'io-x-app-stopped' })
  const excluded = h.add('b:cp-excluded', { container: 'io-x-app-excluded' })
  await h.sched.sweep()
  h.runtime.put(paused.container, 'paused')
  await h.sched.sweep()
  calls.length = 0
  vi.advanceTimersByTime(20_000)
  pressure(h, 100)
  await h.sched.evictForRoom(0, new Set(['b:cp-excluded']))
  const stops = calls.filter((c) => c.startsWith('runtime.stop:'))
  for (const t of [always, paused, stopped, excluded]) {
    expect(stops.some((c) => c.includes(t.container)), t.container).toBe(false)
  }
})

test('eviction hard guards: a just-woken service, a freshly stamped one and a held one are never the victim', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '20', INSTA_OSS_WAKE_PROTECT_SEC: '60' })
  const woken = h.add(K)
  const held = h.add(K2)
  await h.sched.sweep()
  calls.length = 0
  h.sched.onUp(K)                                       // woken just now
  h.sched.beginHold(K2)
  vi.advanceTimersByTime(20_000)                        // past the recent-traffic guard for both
  pressure(h, 100)
  await h.sched.evictForRoom(0, new Set())
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])   // empty pool, one log line
  // The hold going away makes it a candidate; wake protection still shields the other one.
  h.sched.endHold(K2)
  await h.sched.evictForRoom(0, new Set())
  expect(calls).toContain(`runtime.stop:${held.container}:10`)
  expect(calls.some((c) => c.startsWith(`runtime.stop:${woken.container}`))).toBe(false)
})

test('two services that do not fit together do not ping-pong: the second wake proceeds with an empty pool', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '20', INSTA_OSS_WAKE_PROTECT_SEC: '60' })
  const a = h.add(K)
  const b = h.add(K2)
  h.runtime.put(b.container, 'exited')
  await h.sched.sweep()
  calls.length = 0
  h.sched.onUp(K)                                       // A was woken a moment ago
  vi.advanceTimersByTime(20_000)
  pressure(h, 100)                                      // still under the floor whatever we stop
  await h.sched.wake(K2, { door: 'traffic' })
  expect(calls).toContain(`runtime.start:${b.container}`)               // the wake still proceeds
  expect(calls.some((c) => c.startsWith(`runtime.stop:${a.container}`))).toBe(false)
})

test('a stamp inside two touch-debounce windows protects a service under load', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '20' })
  const t = h.add(K)
  await h.sched.sweep()
  calls.length = 0
  vi.advanceTimersByTime(20_000)
  h.sched.touch(K)                                      // answered a request 0 s ago
  pressure(h, 100)
  await h.sched.evictForRoom(0, new Set())
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
  vi.advanceTimersByTime(11_000)                        // 2 * touchDebounceMs later it is fair game
  await h.sched.evictForRoom(0, new Set())
  expect(calls).toContain(`runtime.stop:${t.container}:10`)
})

test('eviction is disabled when the box cannot report memory, and the synthetic budget enables it', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '20' })
  h.add(K)
  await h.sched.sweep()
  calls.length = 0
  vi.advanceTimersByTime(20_000)
  h.runtime.mem = null
  await h.sched.evictForRoom(500 * MiB, new Set())
  expect(calls).toEqual([])
  pressure(h, 100)
  await h.sched.evictForRoom(0, new Set())
  expect(calls.some((c) => c.startsWith('runtime.stop:'))).toBe(true)
})

test('a wake asks for room sized by the last RSS sample, the recorded limit, or the per-kind default', async () => {
  const h = harness({ INSTA_OSS_RAM_FLOOR_PCT: '10' })
  const t = h.add(K)
  h.runtime.rss.set(t.container, 700 * MiB)
  await h.sched.sweep()                                  // records lastRssBytes
  h.runtime.put(t.container, 'exited')
  const other = h.add(K2)
  h.runtime.put(other.container, 'running')
  await h.sched.sweep()
  calls.length = 0
  vi.advanceTimersByTime(20_000)
  pressure(h, 500)                                       // above the floor, but not by 700 MiB
  await h.sched.wake(K, { door: 'api' })
  expect(calls).toContain(`runtime.stop:${other.container}:10`)   // room was made for the sample
})

// ---- bookkeeping ---------------------------------------------------------------------------------

test('holds count up and down, and forget/rekey move the record', async () => {
  const h = harness()
  h.add(K)
  expect(h.sched.holds(K)).toBe(0)
  h.sched.beginHold(K); h.sched.beginHold(K)
  expect(h.sched.holds(K)).toBe(2)
  h.sched.endHold(K); h.sched.endHold(K)
  expect(h.sched.holds(K)).toBe(0)

  h.sched.beginHold(K)
  h.sched.rekey(K, K2)
  expect(h.sched.holds(K)).toBe(0)
  expect(h.sched.holds(K2)).toBe(1)
  h.sched.forget([K2])
  expect(h.sched.holds(K2)).toBe(0)
})

test('stateOf maps the snapshot, the sleep mark and the desired state; an unknown key is none', async () => {
  const h = harness()
  const t = h.add(K)
  expect(h.sched.stateOf('nobody:cp-x')).toBe('none')
  await h.sched.sweep()
  expect(h.sched.stateOf(K)).toBe('running')
  h.runtime.put(t.container, 'restarting')
  await h.sched.sweep()
  expect(h.sched.stateOf(K)).toBe('starting')
  h.runtime.put(t.container, 'exited')
  await h.sched.sweep()
  expect(h.sched.stateOf(K)).toBe('stopped')            // exited with no sleep mark
  h.targets.get(K)!.sleptAt = Date.now()
  expect(h.sched.stateOf(K)).toBe('asleep')             // ...and with one, it is standby
  h.runtime.drop(t.container)
  await h.sched.sweep()
  expect(h.sched.stateOf(K)).toBe('none')
})

test('the ticker sweeps on its own interval and stop() ends it', async () => {
  const h = harness({ INSTA_OSS_SWEEP_SEC: '1', INSTA_OSS_SCHEDULER: '1' })
  const t = h.add(K)
  h.sched.start()
  await vi.advanceTimersByTimeAsync(301_000)
  expect(calls).toContain(`runtime.stop:${t.container}:10`)
  await h.sched.stop()
  h.runtime.put(t.container, 'running')
  h.sched.touch(K)
  calls.length = 0
  await vi.advanceTimersByTimeAsync(301_000)
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
})

test('the ticker never starts when INSTA_OSS_SCHEDULER=0, but wake and sleep still work on demand', async () => {
  const h = harness({ INSTA_OSS_SCHEDULER: '0' })
  const t = h.add(K)
  h.sched.start()
  await vi.advanceTimersByTimeAsync(600_000)
  expect(calls.filter((c) => c.startsWith('runtime.stop:'))).toEqual([])
  expect(await h.sched.sleep(K, 'idle')).toBe(true)
  await h.sched.wake(K, { door: 'api' })
  expect(calls).toContain(`runtime.start:${t.container}`)
})

// The door and reason unions are part of the contract the engine and the router code against.
test('the door and reason unions are the four doors and the three reasons', () => {
  const doors: WakeDoor[] = ['traffic', 'api', 'deploy']
  const reasons: SleepReason[] = ['idle', 'memory', 'branch-create']
  expect(doors).toHaveLength(3)
  expect(reasons).toHaveLength(3)
})
