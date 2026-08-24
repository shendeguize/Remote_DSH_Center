/**
 * Singleton hub state store (design §5.4): one info-route fetch feeding one
 * Image probe, published to both the CenterTab panel and the FooterBadge so
 * the page never runs two probe loops. Pure logic — the fetch implementation
 * and the probe environment are injected; the browser singleton wires the
 * real ones in getHubStore().
 */
import { createProbe } from './probe'
import type { ProbeDeps, ProbeImage, ProbePhase } from './probe'

/** Same-origin discovery route served by the host half (contract, §4.3). */
export const INFO_URL = '/plugins/dsh-center-hub/api/info'
/** Info fetch deadline (§5.4). */
export const INFO_TIMEOUT_MS = 15_000

/** Discovery origin as reported by the host half (§6.1 priority table). */
export type InfoSource = 'config' | 'configFile' | 'probe' | null

/** The info route's response contract (host half, §4.3). */
export interface HubInfo {
  candidateUrl: string | null
  source: InfoSource
  /** Host-side /api/manager/info fingerprint verification result. */
  verified: boolean
  /** Constant-true semantic marker: the result describes the dsh host's machine. */
  hostLocal: boolean
  manager: { version: string; port: number } | null
}

/**
 * Validate the info payload just enough to trust its fields (external HTTP
 * boundary). Missing candidateUrl degrades to null (= no candidate) rather
 * than throwing; a wrong type throws.
 * @param body - parsed JSON body.
 * @returns the normalized info.
 */
function normalizeInfo(body: unknown): HubInfo {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('info 响应不是 JSON 对象，不符合插件契约')
  }
  const record = body as Record<string, unknown>
  const candidateUrl = record['candidateUrl'] ?? null
  if (candidateUrl !== null && typeof candidateUrl !== 'string') {
    throw new Error('info 响应的 candidateUrl 字段类型错误，不符合插件契约')
  }
  const source = record['source']
  const manager = record['manager']
  return {
    candidateUrl,
    source: source === 'config' || source === 'configFile' || source === 'probe' ? source : null,
    verified: record['verified'] === true,
    hostLocal: record['hostLocal'] === true,
    manager: typeof manager === 'object' && manager !== null
      ? (manager as HubInfo['manager'])
      : null,
  }
}

/**
 * Fetch the discovery info from the host half with a hard deadline.
 * @param fetchImpl - fetch implementation (injected for tests).
 * @param timeoutMs - deadline; defaults to the design's 15s.
 * @returns the normalized info.
 * @throws on timeout, non-200, or a contract-violating body.
 */
export async function fetchInfo(
  fetchImpl: typeof fetch,
  timeoutMs: number = INFO_TIMEOUT_MS,
): Promise<HubInfo> {
  const controller = new AbortController()
  const deadline = setTimeout(() => {
    controller.abort()
  }, timeoutMs)
  try {
    const response = await fetchImpl(INFO_URL, { signal: controller.signal })
    if (!response.ok) throw new Error(`info 路由返回 HTTP ${response.status}`)
    return normalizeInfo(await response.json())
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`info 路由 ${Math.round(timeoutMs / 1000)}s 未响应，已超时`)
    }
    throw error
  } finally {
    clearTimeout(deadline)
  }
}

/** Degradation-card selector outcome (§5.2 three cards + the healthy state). */
export type Verdict = 'ok' | 'no-candidate' | 'probe-fail' | 'mismatch'

/**
 * Pure degradation selector (§5.2/§6.3, everUp rule from round 3): which of
 * the three cards (or the healthy iframe) the UI shows for a discovery
 * result + probe verdict.
 *
 * everUp = "this candidate passed the probe earlier in this session". A
 * candidate that WAS reachable and now fails is a dead/restarting local
 * manager (card ② with the `dshc up` guidance) — never the collision case:
 * without everUp, a stale `verified: true` from before the manager died
 * would misclassify the outage as 'mismatch' (round 3 smoke finding).
 * 'mismatch' is reserved for candidates that never worked here despite the
 * host half verifying them on ITS machine (§6.3 collision).
 * @param info - discovery fields plus the session everUp flag (null when
 * the info fetch itself failed).
 * @param probeUp - whether the browser-side Image probe passed.
 * @returns the verdict driving card selection.
 */
export function classify(
  info: (Pick<HubInfo, 'candidateUrl' | 'verified'> & { everUp?: boolean }) | null,
  probeUp: boolean,
): Verdict {
  if (info === null || info.candidateUrl === null) return 'no-candidate'
  if (probeUp) return 'ok'
  if (info.everUp === true) return 'probe-fail'
  return info.verified ? 'mismatch' : 'probe-fail'
}

/**
 * Human label for a discovery source (degradation card & badge popover copy).
 * @param source - discovery origin.
 * @returns Chinese display label.
 */
export function sourceLabel(source: InfoSource): string {
  switch (source) {
    case 'config': return '插件配置 managerUrl'
    case 'configFile': return 'config.json'
    case 'probe': return '出厂候选探测'
    case null: return '未知'
  }
}

/** Published state shared by the tab and the badge (§5.2 store shape). */
export interface HubState {
  phase: ProbePhase
  candidateUrl: string | null
  source: InfoSource
  verified: boolean
  /** Whether the CURRENT candidate ever passed the probe this session
   * (classify's ②-vs-③ discriminator; reset when the candidate changes). */
  everUp: boolean
  lastError: string | null
}

export interface HubStoreDeps {
  fetchImpl: typeof fetch
  probeDeps: ProbeDeps
  /** Test override for the 15s info deadline. */
  infoTimeoutMs?: number
}

export interface HubStore {
  getState(): HubState
  /** Subscribe to state changes. @returns the unsubscriber. */
  subscribe(listener: () => void): () => void
  /** Idempotent kick-off: the first caller starts the info→probe flow. */
  ensureStarted(): void
  /** Manual retry: re-fetch info, then probe with the backoff reset. */
  retry(): void
}

/**
 * Build a hub store around injected dependencies (tests construct their own;
 * the browser shares the getHubStore() singleton).
 * @param deps - fetch + probe environment.
 * @returns the store handle.
 */
export function createHubStore(deps: HubStoreDeps): HubStore {
  const probe = createProbe(deps.probeDeps)
  let state: HubState = {
    phase: 'idle',
    candidateUrl: null,
    source: null,
    verified: false,
    everUp: false,
    lastError: null,
  }
  let started = false
  /** Bumped per run so a superseded run's late results are dropped. */
  let runId = 0
  const listeners = new Set<() => void>()

  function setState(patch: Partial<HubState>): void {
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }

  probe.subscribe(() => {
    const phase = probe.getPhase()
    // 'idle' means the probe is not driving (stopped / never started) —
    // the run flow owns the store phase then.
    if (phase === 'idle') return
    // A pass latches everUp for the current candidate (classify ② vs ③).
    setState(phase === 'up' ? { phase, everUp: true } : { phase })
  })

  async function run(): Promise<void> {
    const id = ++runId
    setState({ phase: 'probing', lastError: null })
    let info: HubInfo
    try {
      info = await fetchInfo(deps.fetchImpl, deps.infoTimeoutMs ?? INFO_TIMEOUT_MS)
    } catch (error) {
      if (id !== runId) return
      setState({
        phase: 'down',
        candidateUrl: null,
        source: null,
        verified: false,
        everUp: false,
        lastError: error instanceof Error ? error.message : String(error),
      })
      return
    }
    if (id !== runId) return
    setState({
      candidateUrl: info.candidateUrl,
      source: info.source,
      verified: info.verified,
      // everUp is per-candidate: a changed candidate starts over.
      everUp: info.candidateUrl === state.candidateUrl ? state.everUp : false,
      lastError: null,
    })
    if (info.candidateUrl === null) {
      // No browser-side factory-port blind probing (§6.2): without a
      // candidate there is nothing to probe — straight to card ①.
      setState({ phase: 'down' })
      return
    }
    probe.start(info.candidateUrl)
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    ensureStarted() {
      if (started) return
      started = true
      void run()
    },
    retry() {
      // Full re-run: re-fetch info (covers "manager just started" and
      // "config just changed") and restart the probe with failures reset —
      // the manual-retry backoff reset of §5.2, one level up.
      void run()
    },
  }
}

/** Real-browser probe environment for the singleton. */
function browserProbeDeps(): ProbeDeps {
  return {
    // HTMLImageElement's handler slots take an Event parameter the probe
    // never supplies nor calls — it only assigns zero-arg closures and null,
    // so the narrower ProbeImage face is safe here.
    createImage: () => new Image() as unknown as ProbeImage,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => {
      window.clearTimeout(handle as number)
    },
    isVisible: () => document.visibilityState !== 'hidden',
    onVisibilityChange(listener) {
      document.addEventListener('visibilitychange', listener)
      return () => {
        document.removeEventListener('visibilitychange', listener)
      }
    },
  }
}

let singleton: HubStore | null = null

/**
 * The browser singleton — CenterTab and FooterBadge share one probe loop
 * (§5.4: no double probing). Lazily constructed so importing this module in
 * Node (tests) never touches the DOM.
 * @returns the shared store.
 */
export function getHubStore(): HubStore {
  singleton ??= createHubStore({
    fetchImpl: (input, init) => fetch(input, init),
    probeDeps: browserProbeDeps(),
  })
  return singleton
}
