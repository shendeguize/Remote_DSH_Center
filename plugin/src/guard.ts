/**
 * Five-layer request guard for the plugin's read-only info route (design
 * §7.1).
 *
 * The dsh webServer ships no TLS, no auth and no origin policy, and its
 * `/api` fence does not cover plugin routes — every plugin route brings its
 * own guard. These checks defend against browser-mediated attacks (CSRF,
 * DNS rebinding, cross-site fetches); they are structurally powerless
 * against any local process talking raw loopback TCP, which is the same
 * trust posture as dsh's own `/api` (design §7.2).
 *
 * Everything here is a pure function over a req-like value so each layer is
 * unit-testable without sockets.
 */

/** Minimal request slice the guard needs; `node:http.IncomingMessage` fits. */
export interface GuardRequest {
  method?: string | undefined
  headers: Record<string, string | string[] | undefined>
  socket: { remoteAddress?: string | undefined }
}

/** Guard outcome: pass, or an HTTP status + stable machine code. */
export type GuardVerdict = { ok: true } | { ok: false; status: number; code: string }

/** Hostnames accepted in Host / Origin (both IPv6 spellings kept — WHATWG
 * URL serializes `[::1]`, raw Host headers may carry either form). */
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** First value of a possibly repeated header. */
function headerValue(
  headers: GuardRequest['headers'],
  name: string,
): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

/**
 * Layer ① predicate: is this socket address a loopback peer?
 * Accepts 127.0.0.0/8, `::1`, and the IPv6-mapped `::ffff:127.x.y.z` form
 * (what Node reports on a dual-stack listener). An absent/empty address is
 * NOT loopback — the guard only passes what it can positively verify.
 * @param remoteAddress - `req.socket.remoteAddress`.
 * @returns true when verifiably loopback.
 */
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  const addr = String(remoteAddress ?? '').trim().toLowerCase()
  if (addr === '::1') return true
  const v4 = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)
}

/**
 * Split a Host header into hostname + port. IPv6 brackets stay on the
 * hostname (same convention as the manager's own origin-guard).
 * @param hostHeader - raw Host header value.
 * @returns lowercased hostname and the port digits ('' when absent).
 */
export function splitHostAuthority(hostHeader: string | undefined): { hostname: string; port: string } {
  const raw = String(hostHeader ?? '').trim().toLowerCase()
  if (raw === '') return { hostname: '', port: '' }
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']')
    if (close === -1) return { hostname: '', port: '' }
    const rest = raw.slice(close + 1)
    return { hostname: raw.slice(0, close + 1), port: rest.startsWith(':') ? rest.slice(1) : '' }
  }
  const i = raw.lastIndexOf(':')
  return i === -1 ? { hostname: raw, port: '' } : { hostname: raw.slice(0, i), port: raw.slice(i + 1) }
}

const FORBIDDEN_REMOTE: GuardVerdict = { ok: false, status: 403, code: 'FORBIDDEN_REMOTE' }
const FORBIDDEN_HOST: GuardVerdict = { ok: false, status: 403, code: 'FORBIDDEN_HOST' }
const FORBIDDEN_ORIGIN: GuardVerdict = { ok: false, status: 403, code: 'FORBIDDEN_ORIGIN' }
const UNSUPPORTED_MEDIA: GuardVerdict = { ok: false, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' }

/**
 * Run the five guard layers in order (design §7.1).
 *
 * ① loopback-only socket peer — holds even when the host dsh listens on
 *   0.0.0.0, and in the tunnel case too: an `ssh -L` request lands from the
 *   remote machine's own sshd, so `remoteAddress` is still loopback.
 * ② Host must name a loopback authority (DNS-rebinding stopper: a rebound
 *   attacker domain resolves to 127.0.0.1 but still carries its own name in
 *   Host).
 * ③ When Origin is present it must be same-origin with the Host authority
 *   (loopback name class + same port); `sec-fetch-site: cross-site` is
 *   rejected outright.
 * ④ POST requires `application/json`, else 415. There is no POST endpoint
 *   today — the branch exists so a future endpoint cannot forget it.
 * ⑤ Write-action two-phase gate (prepare/confirmToken/execute): deliberately
 *   NOT implemented — this plugin has no write endpoint. Design promise
 *   (§7.1 #5): if any write action ever lands it must bring the two-phase
 *   gate plus a default-off master switch with it.
 *
 * @param req - req-like value (see {@link GuardRequest}).
 * @returns `{ok: true}` to proceed, or the status/code to answer with.
 */
export function guardRequest(req: GuardRequest): GuardVerdict {
  // ① socket peer
  if (!isLoopbackAddress(req.socket.remoteAddress)) return FORBIDDEN_REMOTE

  // ② Host authority
  const authority = splitHostAuthority(headerValue(req.headers, 'host'))
  if (!LOOPBACK_NAMES.has(authority.hostname)) return FORBIDDEN_HOST

  // ③ Origin / fetch-metadata
  const secFetchSite = headerValue(req.headers, 'sec-fetch-site')
  if (secFetchSite !== undefined && secFetchSite.trim().toLowerCase() === 'cross-site') {
    return FORBIDDEN_ORIGIN
  }
  const origin = headerValue(req.headers, 'origin')
  if (origin !== undefined && origin !== '') {
    // 'null' (file://, sandboxed iframes) and any garbage fail the parse.
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      return FORBIDDEN_ORIGIN
    }
    const sameOrigin = parsed.protocol === 'http:'
      && LOOPBACK_NAMES.has(parsed.hostname.toLowerCase())
      && (parsed.port === '' ? '80' : parsed.port) === (authority.port === '' ? '80' : authority.port)
    if (!sameOrigin) return FORBIDDEN_ORIGIN
  }

  // ④ Content-Type gate for writes
  if (String(req.method ?? '').toUpperCase() === 'POST') {
    const contentType = headerValue(req.headers, 'content-type') ?? ''
    if (!/^application\/json\b/i.test(contentType.trim())) return UNSUPPORTED_MEDIA
  }

  // ⑤ two-phase write gate: intentionally absent, see the doc block above.
  return { ok: true }
}
