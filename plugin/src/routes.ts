/**
 * The plugin's single web route: `GET /plugins/dsh-center-hub/api/info`
 * (design §4.3). Read-only, guarded (see ./guard.ts), serialized verbatim
 * from the discovery result — no write endpoint, no SSE, no WS. Realtime
 * visibility of the manager is the iframe'd Hub's own job.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DiscoveryCache, DiscoveryResult, ManagerFingerprint } from './discovery'
import { guardRequest } from './guard'

/** Route path under the `/plugins/<package name>/` namespace convention. */
export const INFO_ROUTE_PATH = '/plugins/dsh-center-hub/api/info'

/**
 * Structural slice of the dsh web-server service (`ctx.webServer`). The
 * published cordis types don't declare host services, so the plugin types
 * the registration shape it actually uses (agent-teams precedent).
 * Duplicate (kind, path) registration throws host-side, which doubles as
 * the double-mount backstop.
 */
export interface WebRouteHost {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * Verbatim wire contract of the info route (design §4.3) — the browser half
 * consumes exactly this shape.
 */
export interface InfoResponse {
  candidateUrl: string | null
  source: 'config' | 'configFile' | 'probe' | null
  verified: boolean
  /** Constant-true semantic marker: this result describes the machine the
   * dsh HOST process runs on (§6.3 collision disambiguation). */
  hostLocal: true
  /** Readback digest — only version/port pass through, never the full info. */
  manager: ManagerFingerprint | null
}

/**
 * Project a discovery result onto the wire contract. Re-picks the two
 * manager fields explicitly so nothing extra can ever leak through.
 * @param result - one discovery outcome.
 * @returns the JSON body to send.
 */
export function buildInfoResponse(result: DiscoveryResult): InfoResponse {
  return {
    candidateUrl: result.candidateUrl,
    source: result.source,
    verified: result.verified,
    hostLocal: true,
    manager: result.manager === null
      ? null
      : { version: result.manager.version, port: result.manager.port },
  }
}

/** Write a JSON response (no-store: this is a live snapshot, never cache). */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Build the info route handler: guard → method gate → cached discovery →
 * contract JSON. Any internal failure answers 500 instead of becoming an
 * unhandled rejection.
 * @param discovery - the discovery cache.
 * @returns node:http handler.
 */
export function createInfoHandler(
  discovery: DiscoveryCache,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const verdict = guardRequest(req)
      if (!verdict.ok) {
        sendJson(res, verdict.status, { error: verdict.code })
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
        res.end()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const refresh = url.searchParams.get('refresh') === '1'
      sendJson(res, 200, buildInfoResponse(await discovery.get(refresh)))
    } catch {
      sendJson(res, 500, { error: 'INTERNAL' })
    }
  }
}

/**
 * Register the info route on the host web server. `kind: 'exact'` — one
 * endpoint, one path (query strings don't participate in exact matching).
 * The disposer is wrapped in `ctx.effect`, so unloading the plugin tears
 * the route down with the fiber.
 * @param ctx - cordis host context (webServer present per `inject`).
 * @param discovery - the discovery cache to serve from.
 */
export function registerInfoRoute(ctx: Context, discovery: DiscoveryCache): void {
  const webServer = (ctx as Context & { webServer: WebRouteHost }).webServer
  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: INFO_ROUTE_PATH,
      handler: createInfoHandler(discovery),
    }),
    'dsh-center-hub: info route',
  )
}
