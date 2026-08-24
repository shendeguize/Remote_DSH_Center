/**
 * Manager port discovery (design §4.2 / §6.1, ADR-4).
 *
 * Priority: plugin config `managerUrl` (source `config`) → `manager.port`
 * read from `$DSHC_HOME/config.json` (source `configFile`) → factory
 * candidate 7788 when the file exists without that field (source `probe`).
 * No config file at all means this machine most likely has no Center — we
 * do not guess, `candidateUrl` stays null.
 *
 * Whatever the source, the verdict never comes from a constant: a candidate
 * only counts as verified after a fingerprint readback of
 * `GET /api/manager/info` whose JSON carries `version` and a `port` equal to
 * the probed port ("HTTP 200 ≠ the target app" discipline). With `managerUrl`
 * the host-side readback may legitimately fail (the URL is
 * *browser*-reachable by definition); the candidate ships anyway and the
 * browser-side probe is the final judge.
 *
 * One-shot probing only: results live in a promise cache with a 60s TTL and
 * a ≥5s throttle on forced refreshes — no resident polling, no timers.
 */
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Factory-default manager port, used strictly as a *probe candidate* when
 * config.json exists but names no port (design §6.1 row 3). Never a verdict:
 * only the /api/manager/info readback decides (ADR-4). This is the sanctioned
 * plugin-side form of the "no second port constant" rule — an external npm
 * package cannot import the repo's `src/defaults.js`.
 */
export const FACTORY_CANDIDATE_PORT = 7788

/** Default fingerprint readback timeout (design §4.2). */
const PROBE_TIMEOUT_MS = 3_000

/** The two manager/info fields the plugin consumes (never the full info). */
export interface ManagerFingerprint {
  version: string
  port: number
}

/** Where a fingerprint probe connects. */
export interface ProbeTarget {
  hostname: string
  port: number
}

/** Injectable fingerprint prober (tests swap in fakes; must not throw). */
export type FingerprintProbe = (target: ProbeTarget) => Promise<ManagerFingerprint | null>

/** One discovery outcome; the info route serializes this verbatim (§4.3). */
export interface DiscoveryResult {
  candidateUrl: string | null
  source: 'config' | 'configFile' | 'probe' | null
  verified: boolean
  manager: ManagerFingerprint | null
}

/** Injectable inputs for {@link discover} — nothing reads ambient state
 * that tests cannot substitute. */
export interface DiscoverOptions {
  /** Plugin config `managerUrl` ('' = auto discovery). */
  managerUrl?: string
  /** Plugin config `dshcHome` ('' = follow env / factory home). */
  dshcHome?: string
  /** Environment (for `DSHC_HOME`); defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Home directory provider; defaults to `os.homedir`. */
  home?: () => string
  /** Fingerprint prober; defaults to {@link probeManagerInfo}. */
  probe?: FingerprintProbe
}

/**
 * Resolve the Center config file path: explicit plugin config beats the
 * `DSHC_HOME` environment variable beats the factory `~/.dsh_center/`
 * (mirrors the manager's own `resolvePaths` contract).
 * @param dshcHome - plugin config value ('' / undefined = not set).
 * @param env - environment map.
 * @param home - home directory provider.
 * @returns absolute path of config.json.
 */
export function resolveConfigFilePath(
  dshcHome: string | undefined,
  env: Record<string, string | undefined>,
  home: () => string,
): string {
  const dir = dshcHome !== undefined && dshcHome !== ''
    ? dshcHome
    : env.DSHC_HOME !== undefined && env.DSHC_HOME !== ''
      ? env.DSHC_HOME
      : path.join(home(), '.dsh_center')
  return path.join(path.resolve(dir), 'config.json')
}

/**
 * Fingerprint readback: `GET http://<target>/api/manager/info` over raw
 * `node:http` — deliberately not fetch, so a system proxy can never swallow
 * the loopback readback (design §4.2 proxy trap).
 *
 * Verified means: HTTP 200, body is JSON, carries a string `version` and a
 * numeric `port`, and that port equals the port we dialed. Anything else —
 * wrong fingerprint on a 200, non-200, timeout, refused — is null.
 *
 * @param target - hostname/port to dial.
 * @param options - timeoutMs override (default 3s).
 * @returns the two-field fingerprint, or null. Never rejects.
 */
export function probeManagerInfo(
  target: ProbeTarget,
  { timeoutMs = PROBE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<ManagerFingerprint | null> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: '/api/manager/info',
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { text += chunk })
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null)
          try {
            const body = JSON.parse(text) as { version?: unknown; port?: unknown }
            const { version, port } = body
            if (typeof version === 'string' && typeof port === 'number' && port === target.port) {
              resolve({ version, port })
            } else {
              resolve(null)
            }
          } catch {
            resolve(null)
          }
        })
        res.on('error', () => resolve(null))
      },
    )
    // destroy() surfaces as an 'error' (ECONNRESET), which resolves null below
    req.on('timeout', () => { req.destroy() })
    req.on('error', () => resolve(null))
    req.end()
  })
}

/**
 * Parse a `managerUrl` into a probe target. Unparseable URLs yield null —
 * the candidate still ships (browser probe decides), just unverified.
 * @param rawUrl - plugin config managerUrl.
 * @returns probe target or null.
 */
function probeTargetFromUrl(rawUrl: string): ProbeTarget | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  const port = url.port !== ''
    ? Number(url.port)
    : url.protocol === 'https:' ? 443 : 80
  // node:http wants IPv6 literals without the URL brackets
  return { hostname: url.hostname.replace(/^\[|\]$/g, ''), port }
}

/**
 * Run one discovery pass (no caching — see {@link createDiscovery}).
 * Never rejects: every failure lane degrades to an unverified result.
 * @param options - injectable inputs.
 * @returns the discovery outcome.
 */
export async function discover(options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const probe: FingerprintProbe = options.probe ?? ((target) => probeManagerInfo(target))
  const safeProbe: FingerprintProbe = (target) => probe(target).catch(() => null)

  // Priority 1: explicit managerUrl. Readback runs but cannot veto shipping
  // the candidate — in the remote-dsh scenario the URL is only reachable
  // from the *browser's* machine, not from this host.
  const managerUrl = options.managerUrl ?? ''
  if (managerUrl !== '') {
    const target = probeTargetFromUrl(managerUrl)
    const manager = target === null ? null : await safeProbe(target)
    return { candidateUrl: managerUrl, source: 'config', verified: manager !== null, manager }
  }

  // Priority 2/3: the manager's own config file — the single config source,
  // not a second constant table.
  const filePath = resolveConfigFilePath(
    options.dshcHome,
    options.env ?? process.env,
    options.home ?? homedir,
  )
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No config file: most likely no Center on this machine. Don't guess.
      return { candidateUrl: null, source: null, verified: false, manager: null }
    }
    // File exists but is unreadable: Center is probably installed, port
    // unknown — same treatment as "exists without manager.port".
    text = ''
  }

  let configuredPort: number | null = null
  try {
    const parsed = JSON.parse(text) as { manager?: { port?: unknown } }
    const port = parsed?.manager?.port
    if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65_536) {
      configuredPort = port
    }
  } catch {
    // Unparseable config counts as "no manager.port" — fall through to the
    // factory candidate; the readback still has the only vote.
  }

  const port = configuredPort ?? FACTORY_CANDIDATE_PORT
  const source: DiscoveryResult['source'] = configuredPort === null ? 'probe' : 'configFile'
  const manager = await safeProbe({ hostname: '127.0.0.1', port })
  return {
    candidateUrl: `http://127.0.0.1:${port}`,
    source,
    verified: manager !== null,
    manager,
  }
}

/** Cached discovery face consumed by the info route. */
export interface DiscoveryCache {
  /**
   * Get the (possibly cached) discovery result.
   * @param refresh - true when the browser sent `?refresh=1`.
   */
  get(refresh?: boolean): Promise<DiscoveryResult>
}

/** {@link createDiscovery} knobs: discover inputs + cache clock/windows. */
export interface DiscoveryCacheOptions extends DiscoverOptions {
  /** Result TTL (default 60s, design §4.2). */
  ttlMs?: number
  /** Minimum spacing between forced refreshes (default 5s). */
  refreshMinIntervalMs?: number
  /** Injectable clock for tests. */
  now?: () => number
}

/**
 * Wrap {@link discover} in a promise cache: 60s TTL, `refresh` bypasses the
 * TTL but is throttled to one probe per 5s, concurrent callers share the
 * in-flight promise. No timers of any kind — expiry is judged lazily on
 * read, so there is nothing to dispose and nothing keeps the process alive.
 * @param options - discover inputs + cache knobs.
 * @returns the cache face.
 */
export function createDiscovery(options: DiscoveryCacheOptions = {}): DiscoveryCache {
  const ttlMs = options.ttlMs ?? 60_000
  const refreshMinIntervalMs = options.refreshMinIntervalMs ?? 5_000
  const now = options.now ?? Date.now

  let cached: Promise<DiscoveryResult> | null = null
  let probedAt = 0
  let inflight = false

  return {
    get(refresh = false) {
      const t = now()
      if (cached !== null) {
        const age = t - probedAt
        if (inflight) return cached
        if (refresh ? age < refreshMinIntervalMs : age < ttlMs) return cached
      }
      probedAt = t
      inflight = true
      cached = discover(options).finally(() => { inflight = false })
      return cached
    },
  }
}
