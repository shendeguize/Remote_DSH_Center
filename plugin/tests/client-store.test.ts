/**
 * Hub store logic: the pure degradation selector (four verdicts), info fetch
 * timeout / non-200 / contract handling, and the info→probe flow with
 * idempotent start and full-re-run retry.
 */
import { describe, expect, test } from 'vitest'
import { INFO_URL, classify, createHubStore, fetchInfo, sourceLabel } from '../src/client/store'
import type { HubInfo, HubStore } from '../src/client/store'
import type { ProbeDeps, ProbeImage } from '../src/client/probe'

const CANDIDATE = 'http://127.0.0.1:7788'

const INFO_FOUND: HubInfo = {
  candidateUrl: CANDIDATE,
  source: 'configFile',
  verified: true,
  hostLocal: true,
  manager: { version: '0.2.0', port: 7788 },
}

const INFO_NONE: HubInfo = {
  candidateUrl: null,
  source: null,
  verified: false,
  hostLocal: true,
  manager: null,
}

class FakeImage implements ProbeImage {
  src = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
}

/** Probe environment with dropped timers — store tests settle images by hand. */
function makeProbeEnv(): { images: FakeImage[], deps: ProbeDeps } {
  const images: FakeImage[] = []
  return {
    images,
    deps: {
      createImage() {
        const image = new FakeImage()
        images.push(image)
        return image
      },
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      isVisible: () => true,
      onVisibilityChange: () => () => undefined,
    },
  }
}

function okFetch(info: HubInfo, calls?: string[]): typeof fetch {
  return (input) => {
    calls?.push(String(input))
    return Promise.resolve(new Response(JSON.stringify(info), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  }
}

/** Let the run() promise chain (fetch + json + setState) settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

describe('classify — pure degradation selector (§5.2 three cards + ok)', () => {
  test('probe passed → ok', () => {
    expect(classify(INFO_FOUND, true)).toBe('ok')
  })

  test('no candidate (null info or null candidateUrl) → no-candidate', () => {
    expect(classify(null, false)).toBe('no-candidate')
    expect(classify(INFO_NONE, false)).toBe('no-candidate')
  })

  test('candidate, not host-verified, probe failed → probe-fail', () => {
    expect(classify({ ...INFO_FOUND, verified: false }, false)).toBe('probe-fail')
  })

  test('host-verified candidate, probe failed → mismatch (remote collision, §6.3)', () => {
    expect(classify(INFO_FOUND, false)).toBe('mismatch')
  })

  test('everUp candidate that died → probe-fail, card ② (round 3 smoke fix)', () => {
    expect(classify({ ...INFO_FOUND, everUp: true }, false)).toBe('probe-fail')
  })

  test('never-up + host-verified → mismatch, card ③', () => {
    expect(classify({ ...INFO_FOUND, everUp: false }, false)).toBe('mismatch')
  })

  test('never-up + unverified → probe-fail, card ②', () => {
    expect(classify({ ...INFO_FOUND, verified: false, everUp: false }, false)).toBe('probe-fail')
  })
})

describe('fetchInfo', () => {
  test('parses a 200 payload from the contract route', async () => {
    const calls: string[] = []
    const info = await fetchInfo(okFetch(INFO_FOUND, calls))
    expect(calls).toEqual([INFO_URL])
    expect(info).toEqual(INFO_FOUND)
  })

  test('non-200 rejects with the status in the message', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response('nope', { status: 503 }))
    await expect(fetchInfo(fetchImpl)).rejects.toThrow(/HTTP 503/)
  })

  test('timeout aborts the request and rejects', async () => {
    const fetchImpl: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new Error('aborted'))
      })
    })
    await expect(fetchInfo(fetchImpl, 20)).rejects.toThrow(/未响应/)
  })

  test('contract-violating body rejects', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response(JSON.stringify([1, 2]), { status: 200 }))
    await expect(fetchInfo(fetchImpl)).rejects.toThrow(/不符合插件契约/)
  })
})

describe('sourceLabel', () => {
  test('labels every discovery source', () => {
    expect(sourceLabel('config')).toBe('插件配置 managerUrl')
    expect(sourceLabel('configFile')).toBe('config.json')
    expect(sourceLabel('probe')).toBe('出厂候选探测')
    expect(sourceLabel(null)).toBe('未知')
  })
})

describe('hub store flow', () => {
  function makeStore(fetchImpl: typeof fetch): { store: HubStore, images: FakeImage[] } {
    const env = makeProbeEnv()
    return { store: createHubStore({ fetchImpl, probeDeps: env.deps }), images: env.images }
  }

  test('candidate flows into a probe; onload lands up', async () => {
    const { store, images } = makeStore(okFetch(INFO_FOUND))
    store.ensureStarted()
    expect(store.getState().phase).toBe('probing')
    await flush()
    const state = store.getState()
    expect(state.candidateUrl).toBe(CANDIDATE)
    expect(state.source).toBe('configFile')
    expect(state.verified).toBe(true)
    expect(images).toHaveLength(1)
    images[0]!.onload!()
    expect(store.getState().phase).toBe('up')
    expect(classify(store.getState(), true)).toBe('ok')
  })

  test('verified candidate + probe failure lands down → mismatch verdict', async () => {
    const { store, images } = makeStore(okFetch(INFO_FOUND))
    store.ensureStarted()
    await flush()
    images[0]!.onerror!()
    const state = store.getState()
    expect(state.phase).toBe('down')
    expect(classify(state, false)).toBe('mismatch')
  })

  test('null candidate lands down without probing → no-candidate verdict', async () => {
    const { store, images } = makeStore(okFetch(INFO_NONE))
    store.ensureStarted()
    await flush()
    const state = store.getState()
    expect(state.phase).toBe('down')
    expect(state.candidateUrl).toBeNull()
    expect(state.lastError).toBeNull()
    expect(images).toHaveLength(0)
    expect(classify(state, false)).toBe('no-candidate')
  })

  test('info failure lands down with lastError, no probe', async () => {
    const { store, images } = makeStore(() =>
      Promise.resolve(new Response('boom', { status: 500 })))
    store.ensureStarted()
    await flush()
    const state = store.getState()
    expect(state.phase).toBe('down')
    expect(state.lastError).toMatch(/HTTP 500/)
    expect(images).toHaveLength(0)
  })

  test('ensureStarted is idempotent: one fetch, one probe', async () => {
    const calls: string[] = []
    const { store, images } = makeStore(okFetch(INFO_FOUND, calls))
    store.ensureStarted()
    store.ensureStarted()
    await flush()
    expect(calls).toHaveLength(1)
    expect(images).toHaveLength(1)
  })

  test('retry re-fetches info and restarts the probe', async () => {
    let candidate: string | null = null
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response(
      JSON.stringify({ ...INFO_NONE, candidateUrl: candidate, source: candidate === null ? null : 'probe' }),
      { status: 200 },
    ))
    const { store, images } = makeStore(fetchImpl)
    store.ensureStarted()
    await flush()
    expect(store.getState().phase).toBe('down')
    expect(images).toHaveLength(0)
    // The manager came up in the meantime — retry must pick it up.
    candidate = CANDIDATE
    store.retry()
    await flush()
    expect(store.getState().candidateUrl).toBe(CANDIDATE)
    expect(images).toHaveLength(1)
    images[0]!.onload!()
    expect(store.getState().phase).toBe('up')
  })

  test('up → dead re-classifies as probe-fail, not mismatch (everUp latched)', async () => {
    const { store, images } = makeStore(okFetch(INFO_FOUND))
    store.ensureStarted()
    await flush()
    images[0]!.onload!()
    expect(store.getState().everUp).toBe(true)
    // Manager dies; the next attempt against the SAME candidate fails.
    store.retry()
    await flush()
    images.at(-1)!.onerror!()
    const state = store.getState()
    expect(state.phase).toBe('down')
    expect(state.everUp).toBe(true) // same candidate keeps the latch
    expect(classify(state, false)).toBe('probe-fail')
  })

  test('candidate change resets everUp (③ becomes reachable again)', async () => {
    let url = CANDIDATE
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response(
      JSON.stringify({ ...INFO_FOUND, candidateUrl: url }),
      { status: 200 },
    ))
    const { store, images } = makeStore(fetchImpl)
    store.ensureStarted()
    await flush()
    images[0]!.onload!()
    expect(store.getState().everUp).toBe(true)
    url = 'http://127.0.0.1:9900'
    store.retry()
    await flush()
    expect(store.getState().everUp).toBe(false)
    images.at(-1)!.onerror!()
    expect(classify(store.getState(), false)).toBe('mismatch')
  })

  test('subscribers hear state changes and can unsubscribe', async () => {
    const { store } = makeStore(okFetch(INFO_NONE))
    let heard = 0
    const off = store.subscribe(() => {
      heard += 1
    })
    store.ensureStarted()
    await flush()
    expect(heard).toBeGreaterThan(0)
    const before = heard
    off()
    store.retry()
    await flush()
    expect(heard).toBe(before)
  })
})
