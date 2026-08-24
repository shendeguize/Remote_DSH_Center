/**
 * Image liveness probe with bounded backoff (design §5.2) — a pure state
 * machine, UI-free: every environment touchpoint (Image constructor, timers,
 * visibility) is injected, so tests drive it with fakes.
 *
 * The probe sets `new Image().src = candidateUrl + '/favicon.svg'`: an <img>
 * fetch is a no-cors GET without an Origin header, so the manager's
 * origin-guard rule 2 lets it pass, and /favicon.svg is a manager static
 * asset the Hub page references by absolute path.
 *
 * WEAK-FINGERPRINT DECLARATION: onload only proves "something on the
 * candidate port serves favicon.svg". The verdict feeds UI degradation
 * ONLY — it must never enter any security decision.
 *
 * Bounded behavior: a failed attempt schedules the next one after
 * 5s→10s→20s→40s→60s (capped at 60s); a hidden document pauses the loop and
 * the flip back to visible fires one immediate re-probe; retry() resets the
 * backoff. Never an unbounded tight retry loop. A passed probe stays 'up'
 * with a low-frequency 30s keep-alive re-probe (round 2 erratum to §5.4,
 * satisfying M2 acceptance ②: 30s interval + 5s attempt timeout ≤ 60s to
 * turn the badge red after the manager dies); one keep-alive failure flips
 * to 'down' and the backoff loop takes over; recovery flips back to 'up'.
 * Keep-alive and backoff share the single timer slot, cleared by stop() —
 * timers never accumulate or leak.
 */

/** The minimal surface of `new Image()` the probe consumes. */
export interface ProbeImage {
  src: string
  onload: (() => void) | null
  onerror: (() => void) | null
}

/** Injected environment touchpoints (browser wiring lives in store.ts). */
export interface ProbeDeps {
  /** `() => new Image()` in the browser. */
  createImage(): ProbeImage
  /** Timer pair — `window.setTimeout`/`clearTimeout` in the browser. */
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  /** `document.visibilityState !== 'hidden'` in the browser. */
  isVisible(): boolean
  /**
   * Subscribe to visibility flips (`visibilitychange` in the browser).
   * @returns the unsubscriber.
   */
  onVisibilityChange(listener: () => void): () => void
}

/** Probe verdict lifecycle: idle → probing → up | down (down keeps retrying). */
export type ProbePhase = 'idle' | 'probing' | 'up' | 'down'

export interface Probe {
  /** Begin probing a candidate; resets the failure history. */
  start(candidateUrl: string): void
  /** Manual retry: reset the backoff to the first step and probe immediately. */
  retry(): void
  /** Cancel everything (timers, visibility hook, in-flight image) → idle. */
  stop(): void
  getPhase(): ProbePhase
  /** Subscribe to verdict changes. @returns the unsubscriber. */
  subscribe(listener: () => void): () => void
}

/** Manager static asset used as the liveness fingerprint (§5.2). */
export const FAVICON_PATH = '/favicon.svg'
/** One attempt is dead after 5s without onload/onerror (§5.2). */
export const ATTEMPT_TIMEOUT_MS = 5_000
/** Waits after the Nth consecutive failure; the last entry is the cap. */
export const BACKOFF_STEPS_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000, 60_000]
/** Keep-alive re-probe interval while 'up' (+5s attempt timeout ≤ the 60s bound). */
export const KEEPALIVE_INTERVAL_MS = 30_000

/**
 * Backoff wait for the given consecutive-failure count.
 * @param failures - consecutive failures so far (≥ 1).
 * @returns wait in milliseconds, capped at the last backoff step.
 */
export function backoffDelayMs(failures: number): number {
  const step = Math.min(Math.max(failures, 1), BACKOFF_STEPS_MS.length) - 1
  return BACKOFF_STEPS_MS[step] ?? 0
}

/**
 * Build one probe instance around the injected environment.
 * @param deps - environment touchpoints.
 * @returns the probe handle.
 */
export function createProbe(deps: ProbeDeps): Probe {
  let phase: ProbePhase = 'idle'
  let url = ''
  let failures = 0
  /** Bumped by start()/stop() so in-flight settlements of stale attempts no-op. */
  let generation = 0
  let inFlight = false
  let attemptTimeout: unknown = null
  let retryTimer: unknown = null
  let offVisibility: (() => void) | null = null
  const listeners = new Set<() => void>()

  function notify(): void {
    for (const listener of [...listeners]) listener()
  }

  function cancelRetryTimer(): void {
    if (retryTimer !== null) {
      deps.clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  function cancelAttemptTimeout(): void {
    if (attemptTimeout !== null) {
      deps.clearTimeout(attemptTimeout)
      attemptTimeout = null
    }
  }

  function abandonInFlight(): void {
    generation += 1
    inFlight = false
    cancelAttemptTimeout()
  }

  function schedule(delayMs: number): void {
    cancelRetryTimer()
    // Paused while hidden — the flip back to visible re-probes immediately.
    if (!deps.isVisible()) return
    retryTimer = deps.setTimeout(() => {
      retryTimer = null
      attempt()
    }, delayMs)
  }

  function attempt(): void {
    if (inFlight || url === '') return
    inFlight = true
    cancelRetryTimer()
    // 'down' stays 'down' and 'up' stays 'up' while a re-probe is in flight,
    // so neither the degradation card nor the iframe flickers through a
    // loading state; only the very first attempt surfaces 'probing'.
    if (phase === 'idle') {
      phase = 'probing'
      notify()
    }
    const gen = generation
    let settled = false
    const image = deps.createImage()
    const settle = (alive: boolean): void => {
      if (settled || gen !== generation) return
      settled = true
      inFlight = false
      image.onload = null
      image.onerror = null
      cancelAttemptTimeout()
      if (alive) {
        failures = 0
        phase = 'up'
      } else {
        failures += 1
        phase = 'down'
      }
      // Unconditional: a repeat verdict (down → down) still matters to
      // subscribers that entered 'probing' on their own (store retry flow).
      notify()
      // 'up' keeps the 30s keep-alive; 'down' walks the bounded backoff.
      // Either way exactly one pending timer occupies the shared slot.
      schedule(alive ? KEEPALIVE_INTERVAL_MS : backoffDelayMs(failures))
    }
    image.onload = () => settle(true)
    image.onerror = () => settle(false)
    attemptTimeout = deps.setTimeout(() => settle(false), ATTEMPT_TIMEOUT_MS)
    image.src = url + FAVICON_PATH
  }

  function onVisibilityFlip(): void {
    if (!deps.isVisible()) {
      // Pause: drop the scheduled re-probe (backoff or keep-alive alike);
      // in-flight attempts may finish but their verdict will not schedule
      // while hidden (schedule checks isVisible).
      cancelRetryTimer()
      return
    }
    // Back to visible: one immediate catch-up re-probe (§5.2), which then
    // re-arms the keep-alive or backoff from its own verdict.
    if (url !== '' && !inFlight && phase !== 'idle') attempt()
  }

  function start(candidateUrl: string): void {
    abandonInFlight()
    cancelRetryTimer()
    url = candidateUrl
    failures = 0
    offVisibility ??= deps.onVisibilityChange(onVisibilityFlip)
    attempt()
  }

  function retry(): void {
    if (url === '') return
    failures = 0
    cancelRetryTimer()
    attempt()
  }

  function stop(): void {
    abandonInFlight()
    cancelRetryTimer()
    if (offVisibility !== null) {
      offVisibility()
      offVisibility = null
    }
    url = ''
    failures = 0
    if (phase !== 'idle') {
      phase = 'idle'
      notify()
    }
  }

  return {
    start,
    retry,
    stop,
    getPhase: () => phase,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
