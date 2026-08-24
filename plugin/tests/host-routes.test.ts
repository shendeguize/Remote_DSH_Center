/**
 * Info route wiring and wire contract (design §4.3): registration goes
 * through ctx.effect as an exact route, the handler enforces guard → method
 * gate → cached discovery, and the JSON body matches the verbatim schema —
 * including that `manager` passes through version/port and nothing else.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, test } from 'vitest'
import type { DiscoveryCache, DiscoveryResult } from '../src/discovery'
import {
  INFO_ROUTE_PATH,
  buildInfoResponse,
  createInfoHandler,
  registerInfoRoute,
  type WebRouteHost,
} from '../src/routes'

type Route = Parameters<WebRouteHost['register']>[0]

/** Fake cordis ctx capturing effect labels and registered routes. */
function fakeCtx(): { ctx: Context; routes: Route[]; disposed: () => boolean } {
  const routes: Route[] = []
  let disposals = 0
  const ctx = {
    effect(execute: () => () => void) {
      const dispose = execute()
      return () => { disposals += 1; dispose() }
    },
    webServer: {
      register(route: Route) {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      },
    },
  }
  return { ctx: ctx as unknown as Context, routes, disposed: () => disposals > 0 }
}

const HAPPY_RESULT: DiscoveryResult = {
  candidateUrl: 'http://127.0.0.1:7788',
  source: 'configFile',
  verified: true,
  manager: { version: '0.2.0', port: 7788 },
}

/** Discovery cache stub recording refresh flags. */
function fakeDiscovery(result: DiscoveryResult = HAPPY_RESULT): { cache: DiscoveryCache; refreshes: boolean[] } {
  const refreshes: boolean[] = []
  return {
    refreshes,
    cache: {
      get(refresh = false) {
        refreshes.push(refresh)
        return Promise.resolve(result)
      },
    },
  }
}

/** Minimal req the handler and guard need. */
function fakeReq(overrides: Partial<{ method: string; url: string; headers: Record<string, string>; remoteAddress: string }> = {}): IncomingMessage {
  return {
    method: overrides.method ?? 'GET',
    url: overrides.url ?? INFO_ROUTE_PATH,
    headers: { host: '127.0.0.1:3080', ...overrides.headers },
    socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' },
  } as unknown as IncomingMessage
}

/** Capture-everything fake ServerResponse. */
function fakeRes(): { res: ServerResponse; state: { status: number; headers: Record<string, unknown>; body: string } } {
  const state = { status: 0, headers: {} as Record<string, unknown>, body: '' }
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) {
      state.status = status
      state.headers = headers ?? {}
      return res
    },
    end(chunk?: string) {
      if (chunk !== undefined) state.body = chunk
    },
  }
  return { res: res as unknown as ServerResponse, state }
}

describe('registration', () => {
  test('registers one exact route at the plugin namespace path, inside ctx.effect', () => {
    const { ctx, routes } = fakeCtx()
    registerInfoRoute(ctx, fakeDiscovery().cache)
    expect(routes).toHaveLength(1)
    expect(routes[0]?.kind).toBe('exact')
    expect(routes[0]?.path).toBe('/plugins/dsh-center-hub/api/info')
  })
})

describe('handler', () => {
  test('happy GET answers the verbatim wire contract with no-store', async () => {
    const handler = createInfoHandler(fakeDiscovery().cache)
    const { res, state } = fakeRes()
    await handler(fakeReq(), res)
    expect(state.status).toBe(200)
    expect(state.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(state.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(state.body)).toEqual({
      candidateUrl: 'http://127.0.0.1:7788',
      source: 'configFile',
      verified: true,
      hostLocal: true,
      manager: { version: '0.2.0', port: 7788 },
    })
  })

  test('manager passes through version/port only — extra readback fields never leak', () => {
    const result = {
      ...HAPPY_RESULT,
      manager: { version: '0.2.0', port: 7788, pid: 4242, mode: 'daemon' } as unknown as DiscoveryResult['manager'],
    }
    expect(buildInfoResponse(result).manager).toEqual({ version: '0.2.0', port: 7788 })
  })

  test('null-candidate result serializes with explicit nulls and hostLocal stays true', async () => {
    const empty: DiscoveryResult = { candidateUrl: null, source: null, verified: false, manager: null }
    const handler = createInfoHandler(fakeDiscovery(empty).cache)
    const { res, state } = fakeRes()
    await handler(fakeReq(), res)
    expect(JSON.parse(state.body)).toEqual({
      candidateUrl: null,
      source: null,
      verified: false,
      hostLocal: true,
      manager: null,
    })
  })

  test('guard runs first: non-loopback peer gets 403 JSON, discovery untouched', async () => {
    const { cache, refreshes } = fakeDiscovery()
    const handler = createInfoHandler(cache)
    const { res, state } = fakeRes()
    await handler(fakeReq({ remoteAddress: '203.0.113.7' }), res)
    expect(state.status).toBe(403)
    expect(JSON.parse(state.body)).toEqual({ error: 'FORBIDDEN_REMOTE' })
    expect(refreshes).toEqual([])
  })

  test('forged Origin gets 403', async () => {
    const handler = createInfoHandler(fakeDiscovery().cache)
    const { res, state } = fakeRes()
    await handler(fakeReq({ headers: { origin: 'http://evil.example' } }), res)
    expect(state.status).toBe(403)
    expect(JSON.parse(state.body)).toEqual({ error: 'FORBIDDEN_ORIGIN' })
  })

  test('non-GET method is 405 with Allow (after the guard passes)', async () => {
    const handler = createInfoHandler(fakeDiscovery().cache)
    const { res, state } = fakeRes()
    await handler(fakeReq({ method: 'POST', headers: { 'content-type': 'application/json' } }), res)
    expect(state.status).toBe(405)
    expect(state.headers.allow).toBe('GET, HEAD')
  })

  test('?refresh=1 forwards refresh=true, plain GET forwards false', async () => {
    const { cache, refreshes } = fakeDiscovery()
    const handler = createInfoHandler(cache)
    await handler(fakeReq(), fakeRes().res)
    await handler(fakeReq({ url: `${INFO_ROUTE_PATH}?refresh=1` }), fakeRes().res)
    await handler(fakeReq({ url: `${INFO_ROUTE_PATH}?refresh=0` }), fakeRes().res)
    expect(refreshes).toEqual([false, true, false])
  })

  test('a discovery rejection becomes a 500, not an unhandled rejection', async () => {
    const cache: DiscoveryCache = { get: () => Promise.reject(new Error('boom')) }
    const handler = createInfoHandler(cache)
    const { res, state } = fakeRes()
    await handler(fakeReq(), res)
    expect(state.status).toBe(500)
    expect(JSON.parse(state.body)).toEqual({ error: 'INTERNAL' })
  })
})
