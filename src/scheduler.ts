// The scheduler: what makes a single node behave like a serverless one (contract 00 sections 8.3
// and 13, plan 03).
//
// Three jobs, one lock. It sleeps idle services (`docker stop` with a grace, never `docker pause`),
// wakes them on the three doors (traffic, api, deploy), and evicts the least recently active
// service when free RAM drops below the floor.
// The lock is `withOp`: exclusive per ServiceKey, taken by EVERY container-mutating path in the
// engine (deploy, restart, lifecycle, branch create, teardown, service add/remove/rename, limits),
// re-entrant inside the acquiring async context, and visible to the sweep so a service with an
// operation in flight is never a sleep candidate (decision 52).
//
// Everything the ledger holds is in memory (decision 10): activity stamps, wake singleflight, RSS
// samples, holds. The only thing that reaches state.json is `sleptAt`, through `hooks.markSlept`,
// so runtime-health can tell standby from crashed after a restart.
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import type { Config } from './config'
import { docker } from './docker'
import { parseSize } from './observe'
import type { ManagedDbType, ServiceKey, ServiceKind, ServiceLimits } from './types'
import type { UpstreamLike } from './upstream'

/** One schedulable service, projected out of state.json by the engine on every read (contract 8.3). */
export interface ServiceTarget {
  key: ServiceKey
  kind: ServiceKind
  container: string
  network: string
  port: number
  projectId: string
  branchId: string
  serviceId: string
  alwaysOn: boolean
  desiredState: 'running' | 'stopped' | 'suspended'
  idleSec: number
  limits?: ServiceLimits
  managedType?: ManagedDbType
  sleptAt: number | null
  createdAt: number
}

export type ContainerState = 'running' | 'paused' | 'exited' | 'created' | 'restarting' | 'dead'

/** The docker seam. `DockerRuntime` below is production; `FakeRuntime` (test/fakes.ts) is the single
 *  fake state store every fake-adapter suite reads, so the routes and the scheduler agree. */
export interface Runtime {
  /** Every container docker knows, by name (`docker ps -a`); the id feeds `upstream.forgetIfChanged`. */
  containers(): Promise<Map<string, { state: ContainerState; id: string }>>
  /** RSS bytes per container name (`docker stats --no-stream`). */
  stats(): Promise<Map<string, number>>
  /** Host memory, or null when this box cannot report it (macOS without INSTA_OSS_MEM_BUDGET_MB). */
  memory(): { availableBytes: number; totalBytes: number } | null
  start(container: string): Promise<void>
  stop(container: string, graceSec: number): Promise<void>
  unpause(container: string): Promise<void>
  update(container: string, limits: ServiceLimits): Promise<void>
  /** Readiness: postgres answers `pg_isready`, everything else a TCP dial through the upstream. */
  probe(t: ServiceTarget): Promise<boolean>
}

/** Traffic asked for a service the developer stopped: the lanes answer 503 and never wake it. */
export class ServiceStoppedError extends Error { constructor() { super('service is stopped') } }
/** The container started but never became ready inside `INSTA_OSS_WAKE_TIMEOUT_SEC`. */
export class WakeTimeoutError extends Error {
  constructor(sec: number) { super(`service did not become ready within ${sec} s`) }
}
/** The lock was taken and the container is not there: a deploy is between `rm -f` and `create`, or
 *  the service is gone. Never `docker start` on a name that does not exist. */
export class NoContainerError extends Error {
  constructor() { super('service has no container (deploy in progress or removed)') }
}
/** The key names no service any more (removed while an op or a wake was queued behind it). */
export class NoTargetError extends Error { constructor() { super('service not found') } }

export type SleepReason = 'idle' | 'memory' | 'branch-create'
export type WakeDoor = 'traffic' | 'api' | 'deploy'

export interface SchedulerHooks {
  /** `sleptAt` on the service's row: an audit-class write (decision 54). */
  markSlept(key: ServiceKey, at: number | null): void
  /** One resource event (`service.sleep` / `service.wake`, decision 39). */
  emit(key: ServiceKey, kind: string, payload: Record<string, unknown>): void
  /** True while the boot data migration runs: the sweep stays inert (decision 24). */
  booting?(): boolean
}

const MiB = 1024 * 1024
/** What a wake assumes a service needs when nothing has ever been measured for it. */
const DEFAULT_RSS: Record<ServiceKind, number> = { compute: 256 * MiB, postgres: 128 * MiB, managed: 256 * MiB }
/** How many idle services the sweep stops at once. */
const SLEEP_CONCURRENCY = 4
/** Readiness poll interval inside a wake. */
const PROBE_INTERVAL_MS = 250

const sleepFor = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms).unref?.() })

interface LedgerEntry { lastActiveAt: number; wokeAt?: number; lastRssBytes?: number }
interface OpEntry { chain: Promise<unknown>; count: number }

export class Scheduler {
  private ledger = new Map<ServiceKey, LedgerEntry>()
  private ops = new Map<ServiceKey, OpEntry>()
  private owned = new AsyncLocalStorage<Set<ServiceKey>>()
  private wakes = new Map<ServiceKey, Promise<void>>()
  private sleeping = new Set<ServiceKey>()
  private holdCounts = new Map<ServiceKey, number>()
  /** The last `docker ps -a` snapshot, keyed by container name: what `stateOf` answers from. */
  private stateCache = new Map<string, { state: ContainerState; id: string }>()
  private timer: ReturnType<typeof setInterval> | undefined
  private sweepInFlight: Promise<void> | undefined
  private stopped = false
  private memoryWarned = false
  private evictionLogged = false

  constructor(
    private runtime: Runtime,
    private cfg: Config,
    private targets: () => ServiceTarget[],
    private hooks: SchedulerHooks,
    private upstream: UpstreamLike,
  ) {}

  // ---- ledger -----------------------------------------------------------------------------------

  private rec(key: ServiceKey): LedgerEntry {
    let r = this.ledger.get(key)
    if (!r) { r = { lastActiveAt: Date.now() }; this.ledger.set(key, r) }
    return r
  }

  /** A request, a connection read, or a readiness stamp. The ONLY thing that resets the idle clock. */
  touch(key: ServiceKey): void { this.rec(key).lastActiveAt = Date.now() }

  /** First sight of a service: one full idle window, like the cloud's ready stamp. The CREATE grace
   *  is NOT reset here, because it is measured from the row's own `createdAt` (decision 10). */
  register(keys: ServiceKey[] | ServiceKey): void {
    for (const key of Array.isArray(keys) ? keys : [keys]) if (!this.ledger.has(key)) this.rec(key)
  }

  forget(keys: ServiceKey[] | ServiceKey): void {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.ledger.delete(key)
      this.wakes.delete(key)
      this.sleeping.delete(key)
      this.holdCounts.delete(key)
    }
  }

  rekey(from: ServiceKey, to: ServiceKey): void {
    const r = this.ledger.get(from)
    if (r) { this.ledger.set(to, r); this.ledger.delete(from) }
    const h = this.holdCounts.get(from)
    if (h !== undefined) { this.holdCounts.set(to, h); this.holdCounts.delete(from) }
  }

  /** After a deploy, a wake or an unpause: stamp, clear the sleep mark, drop the cached address. */
  onUp(key: ServiceKey): void {
    const r = this.rec(key)
    r.lastActiveAt = Date.now()
    r.wokeAt = Date.now()
    this.hooks.markSlept(key, null)
    this.setCached(key, 'running')
    this.forgetAddress(key)
  }

  /** The scheduler put it to sleep (or a clone was created and never started). */
  onAsleep(key: ServiceKey, _reason: SleepReason): void {
    this.hooks.markSlept(key, Date.now())
    this.setCached(key, 'exited')
    this.forgetAddress(key)
  }

  /** The developer stopped it: NOT sleep, so the sleep mark is cleared (runtime-health reads it). */
  onStopped(key: ServiceKey): void {
    this.hooks.markSlept(key, null)
    this.setCached(key, 'exited')
    this.forgetAddress(key)
  }

  onPaused(key: ServiceKey): void {
    this.setCached(key, 'paused')
    this.forgetAddress(key)
  }

  private setCached(key: ServiceKey, state: ContainerState): void {
    const t = this.targetOf(key)
    if (!t) return
    this.stateCache.set(t.container, { state, id: this.stateCache.get(t.container)?.id ?? '' })
  }

  private forgetAddress(key: ServiceKey): void {
    const t = this.targetOf(key)
    if (t) this.upstream.forget(t.container)
  }

  /** One target by key. Indexed on the ARRAY the engine hands back, which it memoizes on the state
   *  revision, so a proxied request costs a map lookup rather than a scan of every service. */
  private index: { list: ServiceTarget[]; byKey: Map<ServiceKey, ServiceTarget> } | undefined
  targetOf(key: ServiceKey): ServiceTarget | undefined {
    const list = this.targets()
    if (this.index?.list !== list) this.index = { list, byKey: new Map(list.map((t) => [t.key, t])) }
    return this.index.byKey.get(key)
  }

  // ---- router bookkeeping -----------------------------------------------------------------------

  /** In-flight HTTP requests and TCP splices on the key. A held key is never an eviction victim. */
  holds(key: ServiceKey): number { return this.holdCounts.get(key) ?? 0 }
  beginHold(key: ServiceKey): void { this.holdCounts.set(key, this.holds(key) + 1) }
  endHold(key: ServiceKey): void {
    const n = this.holds(key) - 1
    if (n > 0) this.holdCounts.set(key, n)
    else this.holdCounts.delete(key)
  }

  // ---- the operation lock (decision 52) ---------------------------------------------------------

  /** THE mutual exclusion for container work. Keys are de-duplicated and acquired in sorted order
   *  (two multi-key ops can never deadlock), the chain is extended SYNCHRONOUSLY (a caller that
   *  returns before its first await has already reserved its place), and a key the current async
   *  context already holds is skipped, so `lifecycle start -> wake`, `createBranch -> deployLocked
   *  -> wake(source)` and `ensurePgAwake -> wake -> query` re-enter without a second acquisition. */
  withOp<T>(keys: ServiceKey[], fn: () => Promise<T>): Promise<T> {
    const inherited = this.owned.getStore() ?? new Set<ServiceKey>()
    const need = [...new Set(keys)].filter((k) => !inherited.has(k)).sort()
    if (!need.length) return fn()
    const gate = this.enqueue(need)
    const store = new Set<ServiceKey>([...inherited, ...need])
    return (async () => {
      try {
        await gate.ready
        return await this.owned.run(store, fn)
      } finally {
        gate.release()
        for (const k of need) this.release(k)
      }
    })()
  }

  /** `withOp` that refuses instead of queueing: any key held OR queued answers null without running
   *  `fn`. The sweep's `sleep` uses it, so a stop never lands behind a deploy it would undo. */
  tryWithOp<T>(keys: ServiceKey[], fn: () => Promise<T>): Promise<T | null> {
    const inherited = this.owned.getStore() ?? new Set<ServiceKey>()
    const need = [...new Set(keys)].filter((k) => !inherited.has(k)).sort()
    if (need.some((k) => (this.ops.get(k)?.count ?? 0) > 0)) return Promise.resolve(null)
    return this.withOp(keys, fn)
  }

  /** True while any operation holds or waits on the key (the sweep's in-flight test). */
  private busy(key: ServiceKey): boolean {
    return (this.ops.get(key)?.count ?? 0) > 0 || this.wakes.has(key) || this.sleeping.has(key)
  }

  /** Extend every named key's chain with one gate, synchronously. `ready` settles when every
   *  predecessor has finished; `release` lets the next holder of those keys through. */
  private enqueue(keys: ServiceKey[]): { ready: Promise<void>; release: () => void } {
    let release = (): void => {}
    const held = new Promise<void>((r) => { release = () => { r() } })
    const waits: Array<Promise<unknown>> = []
    for (const key of keys) {
      const prev = this.ops.get(key)?.chain ?? Promise.resolve()
      waits.push(prev)
      // The next acquirer of this key waits for our predecessor AND for our own release. A failed
      // op must not wedge the key, so both settle paths continue the chain.
      const chain = prev.then(() => held, () => held)
      this.ops.set(key, { chain, count: (this.ops.get(key)?.count ?? 0) + 1 })
    }
    return { ready: Promise.all(waits.map((p) => p.catch(() => undefined))).then(() => undefined), release }
  }

  private release(key: ServiceKey): void {
    const entry = this.ops.get(key)
    if (!entry) return
    entry.count -= 1
    if (entry.count <= 0) this.ops.delete(key)
  }

  // ---- state ------------------------------------------------------------------------------------

  /** The one runtime-state source (decision 53). `asleep` while a sleep holds the key (so the lanes
   *  take the wake path, which queues behind the stop, instead of dialling a stopping container)
   *  and `starting` while a wake does; otherwise the contract section 13 mapping over the last
   *  `docker ps -a` snapshot, the row's `sleptAt` and its desired state. */
  stateOf(key: ServiceKey): 'running' | 'asleep' | 'stopped' | 'paused' | 'starting' | 'none' {
    if (this.sleeping.has(key)) return 'asleep'
    if (this.wakes.has(key)) return 'starting'
    const t = this.targetOf(key)
    if (!t) return 'none'
    const live = this.stateCache.get(t.container)
    if (!live) return 'none'
    switch (live.state) {
      case 'running': return 'running'
      case 'paused': return 'paused'
      case 'restarting': return 'starting'
      default:
        return t.sleptAt !== null && t.sleptAt !== undefined && t.desiredState === 'running' ? 'asleep' : 'stopped'
    }
  }

  /** One container's last observed docker state, by NAME: what the engine's non-schedulable rows
   *  (the object store) read instead of taking a second `docker ps`. */
  containerState(container: string): ContainerState | undefined { return this.stateCache.get(container)?.state }

  /** `docker update` on one container, through the same seam the sweep uses (so a fake records it). */
  runtimeUpdate(container: string, limits: ServiceLimits): Promise<void> { return this.runtime.update(container, limits) }

  /** Fill the snapshot `stateOf` answers from (ONE docker read), and let the upstream cache drop
   *  addresses of containers that restarted underneath it. */
  async refreshStates(): Promise<void> {
    let containers: Map<string, { state: ContainerState; id: string }>
    try { containers = await this.runtime.containers() } catch { return }
    this.stateCache = containers
    for (const [name, { id }] of containers) if (id) this.upstream.forgetIfChanged(name, id)
  }

  // ---- lifecycle --------------------------------------------------------------------------------

  start(): void {
    this.stopped = false
    void this.reconcile().catch((e: unknown) => {
      console.warn(`warn: scheduler boot reconcile failed: ${e instanceof Error ? e.message : String(e)}`)
    })
    if (!this.cfg.sleep.enabled || this.timer) return
    this.timer = setInterval(() => { void this.tick() }, this.cfg.sleep.sweepSec * 1000)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) { clearInterval(this.timer); this.timer = undefined }
    await this.sweepInFlight?.catch(() => undefined)
  }

  /** Boot: one snapshot, a fresh idle window for every service, and the sleep marks reconciled with
   *  what docker actually runs. NO pressure pass here: with every stamp equal to boot time it would
   *  stop arbitrary running services on a busy box before any traffic could speak for them. */
  private async reconcile(): Promise<void> {
    await this.refreshStates()
    for (const t of this.targets()) {
      this.register(t.key)
      const live = this.stateCache.get(t.container)
      if (live?.state === 'running' && t.sleptAt !== null && t.sleptAt !== undefined) {
        // It came back up on its own (`--restart unless-stopped`): it is not asleep any more.
        this.hooks.markSlept(t.key, null)
        this.touch(t.key)
      }
    }
    // Not a warning when the floor is 0: eviction is off because the operator turned it off, and
    // saying otherwise sends them looking for a missing /proc/meminfo they do not need.
    if (this.cfg.sleep.ramFloorPct > 0 && !this.runtime.memory() && !this.memoryWarned) {
      this.memoryWarned = true
      console.warn('memory-pressure eviction disabled (no /proc/meminfo and no INSTA_OSS_MEM_BUDGET_MB)')
    }
  }

  /** One ticker beat. A tick that lands while a sweep runs is skipped, not queued. */
  private async tick(): Promise<void> {
    if (this.sweepInFlight || this.stopped) return
    this.sweepInFlight = this.sweep().catch((e: unknown) => {
      console.warn(`warn: sleep sweep failed: ${e instanceof Error ? e.message : String(e)}`)
    })
    try { await this.sweepInFlight } finally { this.sweepInFlight = undefined }
  }

  /** The idle sweep, then the memory-pressure pass. Inert while the boot data migration runs. */
  async sweep(): Promise<void> {
    if (this.hooks.booting?.()) return
    this.evictionLogged = false
    await this.refreshStates()
    const targets = this.targets()
    if (targets.some((t) => this.stateCache.get(t.container)?.state === 'running')) {
      try {
        const stats = await this.runtime.stats()
        for (const t of targets) {
          const rss = stats.get(t.container)
          if (rss !== undefined) this.rec(t.key).lastRssBytes = rss
        }
      } catch { /* one missed sample: the next tick takes another */ }
    }
    const now = Date.now()
    const candidates = targets
      .filter((t) => this.isIdleCandidate(t, now))
      .sort((a, b) => this.rec(a.key).lastActiveAt - this.rec(b.key).lastActiveAt)
    for (let i = 0; i < candidates.length; i += SLEEP_CONCURRENCY) {
      const batch = candidates.slice(i, i + SLEEP_CONCURRENCY)
      // allSettled, not all: one docker stop that times out must cost one service on one tick, not
      // the rest of the pass and the pressure pass behind it (plan 03: errors logged, retried next
      // pass).
      const results = await Promise.allSettled(batch.map(async (t) => {
        // The rule is re-read for each candidate at the moment IT is stopped, not once for the pass:
        // every earlier batch awaited a stop that can burn the whole grace (10 s compute, 30 s
        // databases), so with a dozen candidates the third batch starts a minute after `now` was
        // taken. A service that answered a request in between leaves no other trace the sweep sees
        // (a running upstream is dialled directly, with no wake and no op), and this check runs in
        // the same synchronous step that reserves the key's lock, so nothing slips between them.
        if (!this.isIdleCandidate(t, Date.now())) return false
        return this.sleep(t.key, 'idle')
      }))
      for (const [n, r] of results.entries()) {
        if (r.status === 'rejected') {
          const e = r.reason
          console.warn(`warn: sleep ${batch[n].key} failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    await this.evictForRoom(0, new Set())
  }

  /** Every condition of the cloud's idle rule, each able to veto on its own (contract section 13). */
  private isIdleCandidate(t: ServiceTarget, now: number): boolean {
    if (this.stateCache.get(t.container)?.state !== 'running') return false
    if (t.alwaysOn) return false
    if (t.desiredState !== 'running') return false
    if (t.idleSec <= 0) return false
    if (this.busy(t.key)) return false
    if (now - this.rec(t.key).lastActiveAt < t.idleSec * 1000) return false
    // The create grace comes from the ROW, never from the ledger, so a daemon restart does not hand
    // every service a fresh 10 minutes (decision 10).
    if (now - t.createdAt < this.cfg.sleep.createGraceSec * 1000) return false
    return true
  }

  // ---- sleep ------------------------------------------------------------------------------------

  /** Stop one service. Non-blocking on the lock: a key with an operation in flight answers false
   *  and is retried on the next pass. Returns whether the service is now asleep. */
  async sleep(key: ServiceKey, reason: SleepReason): Promise<boolean> {
    const out = await this.tryWithOp([key], async () => {
      const t = this.targetOf(key)
      if (!t) return false
      // Marked FIRST, inside the lock: `stateOf` must report `asleep` for the whole stop, so a
      // request arriving now takes the wake path (queued behind this stop) instead of dialling a
      // container that is shutting down.
      this.sleeping.add(key)
      try {
        const entry = (await this.runtime.containers()).get(t.container)
        const live = entry?.state
        // The re-read under the lock is also the freshest truth there is: keep the snapshot in step,
        // so a container that has gone away is not reported running until the next sweep.
        if (entry) this.stateCache.set(t.container, entry)
        else this.stateCache.delete(t.container)
        if (live === 'paused') return false
        if (live === undefined) return false
        if (live !== 'running') {
          // A clone that was created and never started is already asleep; just mark it.
          if (live === 'created') { this.onAsleep(key, reason); return true }
          return false
        }
        await this.runtime.stop(t.container, this.graceFor(t, reason))
        this.onAsleep(key, reason)
        this.hooks.emit(key, 'service.sleep', { service: t.serviceId, reason })
        return true
      } finally {
        this.sleeping.delete(key)
      }
    })
    return out ?? false
  }

  /** Compute gets the short grace, databases the long one; an eviction victim is always in a hurry
   *  (decision 13). */
  private graceFor(t: ServiceTarget, reason: SleepReason): number {
    if (reason === 'memory') return this.cfg.sleep.stopGraceSec
    return t.kind === 'compute' ? this.cfg.sleep.stopGraceSec : this.cfg.sleep.stopGraceDbSec
  }

  // ---- eviction ---------------------------------------------------------------------------------

  /** Make room for `needBytes` by sleeping the least recently active service, until free memory is
   *  back above the floor. Every guard here is HARD, never a preference: a just-woken service, one
   *  that answered a request seconds ago, and one with a request or splice in flight are never
   *  victims, so two services that do not fit together cannot ping-pong on every request. An empty
   *  pool means the wake proceeds anyway and the kernel is the last resort. */
  async evictForRoom(needBytes: number, exclude: Set<ServiceKey>): Promise<void> {
    // The documented off switch: a floor of 0 means no pressure eviction anywhere, on the sweep's
    // pass and on the wake path alike (decision 12), so a low-RAM runner never stops a container
    // an e2e or a Docker suite is testing.
    if (this.cfg.sleep.ramFloorPct <= 0) return
    const first = this.runtime.memory()
    if (!first) return
    const floor = first.totalBytes * (this.cfg.sleep.ramFloorPct / 100)
    const tried = new Set<ServiceKey>()
    // What this pass has already freed. The runtime does not always see it in time: in budget mode
    // `memory()` answers `budget - lastRssTotal` and that total is only re-sampled by `stats()`,
    // which no wake and no later loop turn calls. Without this, one pass would keep finding the same
    // pressure and sleep EVERY eligible service instead of the least recently active one.
    let freed = 0
    for (let guard = 0; guard < 32; guard++) {
      const mem = this.runtime.memory()
      if (!mem) return
      // Whichever is larger: what the runtime reports (authoritative once it notices a stop) or the
      // pass's own baseline plus what it freed. Never the sum, which would count a stop twice.
      const available = Math.max(mem.availableBytes, first.availableBytes + freed)
      if (available - needBytes >= floor) return
      const now = Date.now()
      const pool = this.targets().filter((t) => this.isVictim(t, now, exclude, tried))
      if (!pool.length) {
        if (!this.evictionLogged) {
          this.evictionLogged = true
          console.warn(`memory pressure: ${Math.round(available / MiB)} MiB free is under the ${this.cfg.sleep.ramFloorPct}% floor and no service can be evicted`)
        }
        return
      }
      pool.sort((a, b) => {
        const d = this.rec(a.key).lastActiveAt - this.rec(b.key).lastActiveAt
        return d !== 0 ? d : (this.rec(b.key).lastRssBytes ?? 0) - (this.rec(a.key).lastRssBytes ?? 0)
      })
      const victim = pool[0]
      tried.add(victim.key)
      if (await this.sleep(victim.key, 'memory')) {
        freed += this.rec(victim.key).lastRssBytes ?? DEFAULT_RSS[victim.kind]
      }
    }
  }

  private isVictim(t: ServiceTarget, now: number, exclude: Set<ServiceKey>, tried: Set<ServiceKey>): boolean {
    if (exclude.has(t.key) || tried.has(t.key)) return false
    if (this.stateCache.get(t.container)?.state !== 'running') return false
    if (t.alwaysOn || t.desiredState !== 'running') return false
    if (this.busy(t.key)) return false
    if (this.holds(t.key) > 0) return false
    const r = this.rec(t.key)
    if (now - r.lastActiveAt < 2 * this.cfg.lanes.touchDebounceMs) return false
    if (r.wokeAt !== undefined && now - r.wokeAt < this.cfg.sleep.wakeProtectSec * 1000) return false
    return true
  }

  // ---- wake -------------------------------------------------------------------------------------

  /** Start a sleeping service and wait until it accepts connections. Singleflight per key: 25
   *  concurrent requests share ONE `docker start` and one readiness wait. The lock is taken
   *  BLOCKING, so a deploy, a lifecycle op or a stop in flight on the same container finishes
   *  first and the target is re-read afterwards. */
  wake(key: ServiceKey, opts: { door: WakeDoor }): Promise<void> {
    const t = this.targetOf(key)
    if (!t) return Promise.reject(new NoTargetError())
    if (this.refuses(t, opts.door)) return Promise.reject(new ServiceStoppedError())
    const inflight = this.wakes.get(key)
    if (inflight) return inflight
    const p = this.withOp([key], () => this.wakeLocked(key, opts.door))
      .finally(() => { this.wakes.delete(key) })
    this.wakes.set(key, p)
    return p
  }

  /** Traffic never wakes a service the developer stopped or suspended; the api and deploy doors are
   *  explicit operations and are never refused. */
  private refuses(t: ServiceTarget, door: WakeDoor): boolean {
    return door === 'traffic' && t.kind === 'compute' && t.desiredState !== 'running'
  }

  private async wakeLocked(key: ServiceKey, door: WakeDoor): Promise<void> {
    const started = Date.now()
    const t = this.targetOf(key)
    if (!t) throw new NoTargetError()
    if (this.refuses(t, door)) throw new ServiceStoppedError()
    const live = (await this.runtime.containers()).get(t.container)
    if (!live) throw new NoContainerError()
    this.stateCache.set(t.container, live)
    if (live.state === 'running') {
      // A deploy that ended in `onUp` makes this wake a no-op: stamp and go.
      if (await this.runtime.probe(t)) {
        this.touch(key)
        if (t.sleptAt !== null && t.sleptAt !== undefined) this.hooks.markSlept(key, null)
        return
      }
    } else if (live.state === 'paused') {
      if (door === 'traffic') throw new Error('service is suspended')
      await this.runtime.unpause(t.container)
    } else if (live.state !== 'restarting') {
      const need = this.rec(key).lastRssBytes ?? (t.limits ? t.limits.memoryMb * MiB : DEFAULT_RSS[t.kind])
      // Concurrently, so the victim's stop grace does not add to the caller's hold; the eviction
      // itself never blocks on a held key (tryWithOp per victim).
      await Promise.all([
        this.evictForRoom(need, new Set([key])).catch(() => undefined),
        this.runtime.start(t.container),
      ])
    }
    await this.awaitReady(t)
    this.onUp(key)
    this.hooks.emit(key, 'service.wake', { service: t.serviceId, door, ms: Date.now() - started })
  }

  /** Poll readiness until the deadline. A container that exits mid-wake ends the wait with its own
   *  error (the sleep mark is left alone: it did not go to sleep, it crashed). */
  private async awaitReady(t: ServiceTarget): Promise<void> {
    const deadline = Date.now() + this.cfg.sleep.wakeTimeoutSec * 1000
    for (;;) {
      if (await this.runtime.probe(t)) return
      const live = (await this.runtime.containers()).get(t.container)?.state
      if (live === 'exited' || live === 'dead') throw new Error('service exited during wake')
      if (Date.now() >= deadline) throw new WakeTimeoutError(this.cfg.sleep.wakeTimeoutSec)
      await sleepFor(PROBE_INTERVAL_MS)
    }
  }
}

// ---- production runtime -------------------------------------------------------------------------

/** How long any single docker call may take before the caller gives up on it. */
const DOCKER_TIMEOUT_MS = 20_000

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`docker ${what} timed out after ${ms} ms`)) }, ms)
    timer.unref?.()
    p.then((v) => { clearTimeout(timer); resolve(v) }, (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))) })
  })
}

/** The `Runtime` over the docker CLI. One `docker ps -a` per sweep and one `docker stats` when
 *  anything runs; `memory()` is synchronous, so it answers from /proc/meminfo (Linux) or from the
 *  synthetic budget minus the last RSS sample (`INSTA_OSS_MEM_BUDGET_MB`, tests and macOS). */
export class DockerRuntime implements Runtime {
  private meminfoMissing = false
  private lastRssTotal = 0
  /** The last per-container sample of `stats()`, so `stop()` can take that container out of the
   *  running total instead of waiting for the next sweep to re-sample it (budget mode). */
  private lastRss = new Map<string, number>()

  constructor(private cfg: Config, private upstream: UpstreamLike) {}

  async containers(): Promise<Map<string, { state: ContainerState; id: string }>> {
    const out = await withTimeout(docker(['ps', '-a', '--format', '{{.Names}}\t{{.State}}\t{{.ID}}']), DOCKER_TIMEOUT_MS, 'ps')
    const map = new Map<string, { state: ContainerState; id: string }>()
    for (const line of out.toString().trim().split('\n').filter(Boolean)) {
      const [name, state, id] = line.split('\t')
      if (name) map.set(name, { state: (state ?? 'exited') as ContainerState, id: id ?? '' })
    }
    return map
  }

  async stats(): Promise<Map<string, number>> {
    const out = await withTimeout(docker(['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}']), DOCKER_TIMEOUT_MS, 'stats')
    const map = new Map<string, number>()
    let total = 0
    for (const line of out.toString().trim().split('\n').filter(Boolean)) {
      const [name, usage] = line.split('\t')
      if (!name) continue
      const bytes = parseSize((usage ?? '0B').split('/')[0] ?? '')
      map.set(name, bytes)
      if (name.startsWith('io-')) total += bytes
    }
    this.lastRssTotal = total
    this.lastRss = map
    return map
  }

  memory(): { availableBytes: number; totalBytes: number } | null {
    const budget = this.cfg.sleep.memBudgetMb
    if (budget !== null) {
      const totalBytes = budget * MiB
      return { totalBytes, availableBytes: Math.max(0, totalBytes - this.lastRssTotal) }
    }
    if (this.meminfoMissing) return null
    try {
      const text = readFileSync('/proc/meminfo', 'utf8')
      const kb = (field: string): number => Number(new RegExp(`^${field}:\\s+(\\d+) kB`, 'm').exec(text)?.[1] ?? NaN)
      const total = kb('MemTotal')
      const available = kb('MemAvailable')
      if (!Number.isFinite(total) || !Number.isFinite(available)) { this.meminfoMissing = true; return null }
      return { totalBytes: total * 1024, availableBytes: available * 1024 }
    } catch {
      this.meminfoMissing = true
      return null
    }
  }

  async start(container: string): Promise<void> {
    await withTimeout(docker(['start', container]), DOCKER_TIMEOUT_MS, 'start')
  }

  /** Sleep is `docker stop` with a grace, never `docker pause`: SIGTERM (SIGINT for the postgres
   *  image, its fast shutdown), then SIGKILL after the grace. Compute containers carry `--init` so
   *  the signal reaches an app whose PID 1 is a shell (decision 60). */
  async stop(container: string, graceSec: number): Promise<void> {
    await withTimeout(docker(['stop', '-t', String(graceSec), container]), DOCKER_TIMEOUT_MS + graceSec * 1000, 'stop')
    // Budget mode has no kernel to ask, so the total it subtracts from the budget is maintained
    // here: a container that is gone is not holding its last sample any more.
    const sample = this.lastRss.get(container)
    if (sample !== undefined) {
      this.lastRss.delete(container)
      this.lastRssTotal = Math.max(0, this.lastRssTotal - sample)
    }
  }

  async unpause(container: string): Promise<void> {
    await withTimeout(docker(['unpause', container]), DOCKER_TIMEOUT_MS, 'unpause')
  }

  async update(container: string, limits: ServiceLimits): Promise<void> {
    await withTimeout(
      docker(['update', '--cpus', String(limits.cpu), '--memory', `${limits.memoryMb}m`, '--memory-swap', `${limits.memoryMb}m`, container]),
      DOCKER_TIMEOUT_MS, 'update',
    )
  }

  /** Postgres is ready when `pg_isready` says so (a TCP accept happens before recovery finishes);
   *  everything else when its port accepts a connection. */
  async probe(t: ServiceTarget): Promise<boolean> {
    if (t.kind === 'postgres') {
      try {
        await withTimeout(docker(['exec', t.container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'app']), DOCKER_TIMEOUT_MS, 'exec pg_isready')
        return true
      } catch { return false }
    }
    return this.upstream.dial(t.container, t.network, t.port, 1000)
  }
}
