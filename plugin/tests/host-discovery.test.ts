/**
 * Discovery priority ladder (design §6.1), home resolution, and the cache
 * TTL/throttle windows — all offline: the fingerprint prober and the clock
 * are injected, config.json states live in throwaway temp dirs.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  FACTORY_CANDIDATE_PORT,
  createDiscovery,
  discover,
  resolveConfigFilePath,
  type FingerprintProbe,
  type ManagerFingerprint,
  type ProbeTarget,
} from '../src/discovery'

const tempDirs: string[] = []

/** Fresh temp dir, cleaned up after each test. */
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-center-hub-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true })
})

/** Recording fake prober answering `fingerprint` (or null) for every call. */
function fakeProbe(fingerprint: ManagerFingerprint | null): { probe: FingerprintProbe; calls: ProbeTarget[] } {
  const calls: ProbeTarget[] = []
  return {
    calls,
    probe: (target) => {
      calls.push(target)
      return Promise.resolve(fingerprint)
    },
  }
}

/** Write a config.json with the given body into `dir`. */
function writeConfig(dir: string, body: unknown): void {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(body))
}

describe('discovery priority ladder', () => {
  test('priority 1: managerUrl wins, source=config, config file never read', async () => {
    const home = tempHome()
    writeConfig(home, { manager: { port: 9999 } }) // present but must be ignored
    const { probe, calls } = fakeProbe({ version: '0.2.0', port: 7788 })
    const result = await discover({
      managerUrl: 'http://127.0.0.1:7788',
      dshcHome: home,
      env: {},
      probe,
    })
    expect(result).toEqual({
      candidateUrl: 'http://127.0.0.1:7788',
      source: 'config',
      verified: true,
      manager: { version: '0.2.0', port: 7788 },
    })
    expect(calls).toEqual([{ hostname: '127.0.0.1', port: 7788 }])
  })

  test('managerUrl with failed readback still ships the candidate, verified=false', async () => {
    const { probe } = fakeProbe(null)
    const result = await discover({ managerUrl: 'http://127.0.0.1:7788', env: {}, probe })
    expect(result).toEqual({
      candidateUrl: 'http://127.0.0.1:7788',
      source: 'config',
      verified: false,
      manager: null,
    })
  })

  test('priority 2: config.json manager.port, source=configFile', async () => {
    const home = tempHome()
    writeConfig(home, { manager: { port: 7799 } })
    const { probe, calls } = fakeProbe({ version: '0.2.0', port: 7799 })
    const result = await discover({ dshcHome: home, env: {}, probe })
    expect(result).toEqual({
      candidateUrl: 'http://127.0.0.1:7799',
      source: 'configFile',
      verified: true,
      manager: { version: '0.2.0', port: 7799 },
    })
    expect(calls).toEqual([{ hostname: '127.0.0.1', port: 7799 }])
  })

  test('priority 3: file exists without manager.port → factory candidate, source=probe', async () => {
    const home = tempHome()
    writeConfig(home, { defaults: {} })
    const { probe, calls } = fakeProbe(null)
    const result = await discover({ dshcHome: home, env: {}, probe })
    expect(result).toEqual({
      candidateUrl: `http://127.0.0.1:${FACTORY_CANDIDATE_PORT}`,
      source: 'probe',
      verified: false,
      manager: null,
    })
    expect(calls).toEqual([{ hostname: '127.0.0.1', port: FACTORY_CANDIDATE_PORT }])
  })

  test('no config file → no guessing: candidateUrl null, probe never called', async () => {
    const home = tempHome() // exists, but holds no config.json
    const { probe, calls } = fakeProbe({ version: 'x', port: 7788 })
    const result = await discover({ dshcHome: home, env: {}, probe })
    expect(result).toEqual({ candidateUrl: null, source: null, verified: false, manager: null })
    expect(calls).toEqual([])
  })

  test('a rejecting injected prober degrades to unverified instead of throwing', async () => {
    const home = tempHome()
    writeConfig(home, { manager: { port: 7799 } })
    const probe: FingerprintProbe = () => Promise.reject(new Error('boom'))
    const result = await discover({ dshcHome: home, env: {}, probe })
    expect(result.verified).toBe(false)
    expect(result.manager).toBeNull()
    expect(result.candidateUrl).toBe('http://127.0.0.1:7799')
  })
})

describe('home resolution (config > DSHC_HOME > ~/.dsh_center)', () => {
  test('dshcHome config beats the DSHC_HOME environment variable', () => {
    expect(resolveConfigFilePath('/cfg/home', { DSHC_HOME: '/env/home' }, () => '/user'))
      .toBe(join('/cfg/home', 'config.json'))
  })

  test('DSHC_HOME beats the factory home', () => {
    expect(resolveConfigFilePath('', { DSHC_HOME: '/env/home' }, () => '/user'))
      .toBe(join('/env/home', 'config.json'))
  })

  test('factory fallback is <home>/.dsh_center/config.json', () => {
    expect(resolveConfigFilePath(undefined, {}, () => '/user'))
      .toBe(join('/user', '.dsh_center', 'config.json'))
  })

  test('discover honors injected env DSHC_HOME (no ambient process.env read)', async () => {
    const envHome = tempHome()
    const dir = join(envHome, 'nested')
    mkdirSync(dir)
    writeConfig(dir, { manager: { port: 7801 } })
    const { probe, calls } = fakeProbe(null)
    const result = await discover({ env: { DSHC_HOME: dir }, home: () => '/nonexistent', probe })
    expect(result.source).toBe('configFile')
    expect(calls).toEqual([{ hostname: '127.0.0.1', port: 7801 }])
  })
})

describe('cache: 60s TTL, refresh throttled to ≥5s, injected clock', () => {
  /** Cache over a counting prober and a manual clock. */
  function setup(): { cache: ReturnType<typeof createDiscovery>; probeCount: () => number; tick: (ms: number) => void } {
    const home = tempHome()
    writeConfig(home, { manager: { port: 7802 } })
    let clock = 1_000_000
    let count = 0
    const cache = createDiscovery({
      dshcHome: home,
      env: {},
      probe: (target) => {
        count += 1
        return Promise.resolve({ version: '0.2.0', port: target.port })
      },
      now: () => clock,
    })
    return { cache, probeCount: () => count, tick: (ms) => { clock += ms } }
  }

  test('within the TTL every get shares one probe', async () => {
    const { cache, probeCount, tick } = setup()
    await cache.get()
    tick(59_999)
    const result = await cache.get()
    expect(result.verified).toBe(true)
    expect(probeCount()).toBe(1)
  })

  test('past the TTL the next get re-probes', async () => {
    const { cache, probeCount, tick } = setup()
    await cache.get()
    tick(60_000)
    await cache.get()
    expect(probeCount()).toBe(2)
  })

  test('refresh bypasses the TTL but is throttled under 5s', async () => {
    const { cache, probeCount, tick } = setup()
    await cache.get()
    tick(4_999)
    await cache.get(true) // throttled → cached result, no new probe
    expect(probeCount()).toBe(1)
    tick(1) // now 5s since the probe
    await cache.get(true)
    expect(probeCount()).toBe(2)
    tick(5_000)
    await cache.get(true) // refresh inside the TTL still re-probes once past 5s
    expect(probeCount()).toBe(3)
  })

  test('concurrent callers share the in-flight probe', async () => {
    const home = tempHome()
    writeConfig(home, { manager: { port: 7803 } })
    let count = 0
    let release!: (value: ManagerFingerprint | null) => void
    const gate = new Promise<ManagerFingerprint | null>((resolve) => { release = resolve })
    const cache = createDiscovery({
      dshcHome: home,
      env: {},
      probe: () => {
        count += 1
        return gate
      },
      now: () => 42,
    })
    const first = cache.get()
    const second = cache.get(true) // even a forced refresh joins the flight
    release({ version: '0.2.0', port: 7803 })
    const [a, b] = await Promise.all([first, second])
    expect(count).toBe(1)
    expect(a).toEqual(b)
  })
})
