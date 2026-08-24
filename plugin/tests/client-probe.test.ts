/**
 * Probe state machine (design §5.2) under fake Image / fake clock /
 * fake visibility: success, the bounded 5/10/20/40/60 backoff walk,
 * visibility pause-resume, and manual-retry backoff reset.
 */
import { describe, expect, test } from 'vitest'
import { ATTEMPT_TIMEOUT_MS, BACKOFF_STEPS_MS, KEEPALIVE_INTERVAL_MS, backoffDelayMs, createProbe } from '../src/client/probe'
import type { Probe, ProbeDeps, ProbeImage } from '../src/client/probe'

const URL = 'http://127.0.0.1:7788'

class FakeImage implements ProbeImage {
  src = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
}

interface Harness {
  probe: Probe
  images: FakeImage[]
  /** Move the fake clock forward, firing due timers in time order. */
  advance(ms: number): void
  setVisible(visible: boolean): void
  /** Delays (from now) of all pending timers, ascending. */
  pendingDelays(): number[]
}

function makeHarness(): Harness {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { at: number, fn: () => void }>()
  const images: FakeImage[] = []
  let visible = true
  const visibilityListeners = new Set<() => void>()
  const deps: ProbeDeps = {
    createImage() {
      const image = new FakeImage()
      images.push(image)
      return image
    },
    setTimeout(fn, ms) {
      const id = nextId
      nextId += 1
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(handle) {
      timers.delete(handle as number)
    },
    isVisible: () => visible,
    onVisibilityChange(listener) {
      visibilityListeners.add(listener)
      return () => {
        visibilityListeners.delete(listener)
      }
    },
  }
  function advance(ms: number): void {
    const target = now + ms
    for (;;) {
      let dueId: number | null = null
      let dueAt = Infinity
      for (const [id, timer] of timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at
          dueId = id
        }
      }
      if (dueId === null) break
      const timer = timers.get(dueId)!
      timers.delete(dueId)
      now = timer.at
      timer.fn()
    }
    now = target
  }
  return {
    probe: createProbe(deps),
    images,
    advance,
    setVisible(next) {
      visible = next
      for (const listener of [...visibilityListeners]) listener()
    },
    pendingDelays: () => [...timers.values()].map((timer) => timer.at - now).sort((a, b) => a - b),
  }
}

describe('backoffDelayMs', () => {
  test('walks the steps and caps at the last one', () => {
    expect(BACKOFF_STEPS_MS).toEqual([5_000, 10_000, 20_000, 40_000, 60_000])
    expect([1, 2, 3, 4, 5, 6, 99].map(backoffDelayMs))
      .toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000])
  })
})

describe('probe state machine', () => {
  test('success: favicon GET onload lands up with one keep-alive armed', () => {
    const h = makeHarness()
    h.probe.start(URL)
    expect(h.probe.getPhase()).toBe('probing')
    expect(h.images).toHaveLength(1)
    expect(h.images[0]!.src).toBe(`${URL}/favicon.svg`)
    h.images[0]!.onload!()
    expect(h.probe.getPhase()).toBe('up')
    // Round 2: exactly one 30s keep-alive timer pending, nothing else.
    expect(h.pendingDelays()).toEqual([KEEPALIVE_INTERVAL_MS])
  })

  test('up → 30s keep-alive failure lands down within the 60s bound', () => {
    const h = makeHarness()
    h.probe.start(URL)
    h.images[0]!.onload!()
    h.advance(KEEPALIVE_INTERVAL_MS) // keep-alive fires at t=30s
    expect(h.images).toHaveLength(2)
    expect(h.probe.getPhase()).toBe('up') // no flicker while in flight
    h.advance(ATTEMPT_TIMEOUT_MS) // dead manager: timeout at t=35s ≤ 60s
    expect(h.probe.getPhase()).toBe('down')
    // The existing backoff loop takes over from here.
    expect(h.pendingDelays()).toEqual([5_000])
  })

  test('hidden pauses the keep-alive; visible resumes it immediately', () => {
    const h = makeHarness()
    h.probe.start(URL)
    h.images[0]!.onload!()
    h.setVisible(false)
    expect(h.pendingDelays()).toEqual([])
    h.advance(600_000)
    expect(h.images).toHaveLength(1) // nothing probed while hidden
    h.setVisible(true) // immediate catch-up re-probe
    expect(h.images).toHaveLength(2)
    h.images[1]!.onload!()
    expect(h.probe.getPhase()).toBe('up')
    expect(h.pendingDelays()).toEqual([KEEPALIVE_INTERVAL_MS])
  })

  test('down → probe recovery flips back to up and re-arms the keep-alive', () => {
    const h = makeHarness()
    h.probe.start(URL)
    h.images[0]!.onerror!()
    expect(h.probe.getPhase()).toBe('down')
    h.advance(5_000) // first backoff step re-probes
    expect(h.images).toHaveLength(2)
    h.images[1]!.onload!()
    expect(h.probe.getPhase()).toBe('up')
    expect(h.pendingDelays()).toEqual([KEEPALIVE_INTERVAL_MS])
  })

  test('failure backoff walks 5/10/20/40/60 and stays capped at 60', () => {
    const h = makeHarness()
    h.probe.start(URL)
    for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]) {
      h.images.at(-1)!.onerror!()
      expect(h.probe.getPhase()).toBe('down')
      expect(h.pendingDelays()).toEqual([delay])
      h.advance(delay)
    }
    // One attempt per step: the initial one plus one per elapsed backoff.
    expect(h.images).toHaveLength(8)
  })

  test('5s attempt timeout counts as failure; late answers are ignored', () => {
    const h = makeHarness()
    h.probe.start(URL)
    const image = h.images[0]!
    h.advance(ATTEMPT_TIMEOUT_MS)
    expect(h.probe.getPhase()).toBe('down')
    // The timed-out attempt detached its handlers — a late onload cannot land.
    expect(image.onload).toBeNull()
    expect(image.onerror).toBeNull()
    expect(h.pendingDelays()).toEqual([5_000])
  })

  test('hidden pauses the backoff; visible fires one immediate re-probe', () => {
    const h = makeHarness()
    h.probe.start(URL)
    h.images[0]!.onerror!()
    expect(h.pendingDelays()).toEqual([5_000])
    h.setVisible(false)
    expect(h.pendingDelays()).toEqual([])
    h.advance(600_000)
    expect(h.images).toHaveLength(1)
    h.setVisible(true)
    expect(h.images).toHaveLength(2)
    h.images[1]!.onload!()
    expect(h.probe.getPhase()).toBe('up')
  })

  test('failure while hidden schedules nothing; visible resumes probing', () => {
    const h = makeHarness()
    h.probe.start(URL)
    h.setVisible(false)
    h.images[0]!.onerror!()
    expect(h.probe.getPhase()).toBe('down')
    expect(h.pendingDelays()).toEqual([])
    h.setVisible(true)
    expect(h.images).toHaveLength(2)
  })

  test('manual retry probes immediately and resets the backoff to step one', () => {
    const h = makeHarness()
    h.probe.start(URL)
    for (const delay of [5_000, 10_000, 20_000]) {
      h.images.at(-1)!.onerror!()
      h.advance(delay)
    }
    h.images.at(-1)!.onerror!()
    expect(h.pendingDelays()).toEqual([40_000])
    h.probe.retry()
    // Immediate attempt: only its own 5s attempt timeout is pending.
    expect(h.pendingDelays()).toEqual([ATTEMPT_TIMEOUT_MS])
    h.images.at(-1)!.onerror!()
    expect(h.pendingDelays()).toEqual([5_000])
  })

  test('visibility flip while up re-probes once without leaving up', () => {
    const h = makeHarness()
    h.probe.start(URL)
    h.images[0]!.onload!()
    h.setVisible(false)
    h.setVisible(true)
    expect(h.images).toHaveLength(2)
    expect(h.probe.getPhase()).toBe('up')
    h.images[1]!.onerror!()
    expect(h.probe.getPhase()).toBe('down')
  })

  test('stop orphans the in-flight attempt and returns to idle', () => {
    const h = makeHarness()
    h.probe.start(URL)
    const image = h.images[0]!
    const load = image.onload!
    h.probe.stop()
    expect(h.probe.getPhase()).toBe('idle')
    expect(h.pendingDelays()).toEqual([])
    load()
    expect(h.probe.getPhase()).toBe('idle')
  })
})
