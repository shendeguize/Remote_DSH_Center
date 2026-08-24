/**
 * Five-layer guard (design §7.1): per-layer rejection lanes and the pass
 * lanes, over pure fake req objects — no sockets anywhere.
 */
import { describe, expect, test } from 'vitest'
import { guardRequest, isLoopbackAddress, splitHostAuthority, type GuardRequest } from '../src/guard'

/** Baseline passing request; overrides shape each case. */
function fakeReq(overrides: {
  method?: string
  headers?: Record<string, string | string[] | undefined>
  remoteAddress?: string | undefined
} = {}): GuardRequest {
  return {
    method: overrides.method ?? 'GET',
    headers: { host: '127.0.0.1:3080', ...overrides.headers },
    socket: { remoteAddress: 'remoteAddress' in overrides ? overrides.remoteAddress : '127.0.0.1' },
  }
}

describe('layer ① loopback-only socket peer', () => {
  test('LAN peer is rejected 403 even if the host listens on 0.0.0.0', () => {
    expect(guardRequest(fakeReq({ remoteAddress: '192.168.1.50' })))
      .toEqual({ ok: false, status: 403, code: 'FORBIDDEN_REMOTE' })
  })

  test('IPv6 non-loopback (mapped and native) is rejected', () => {
    expect(guardRequest(fakeReq({ remoteAddress: '::ffff:10.0.0.9' })).ok).toBe(false)
    expect(guardRequest(fakeReq({ remoteAddress: '2001:db8::1' })).ok).toBe(false)
  })

  test('absent remoteAddress is not positively loopback → rejected', () => {
    expect(guardRequest(fakeReq({ remoteAddress: undefined })).ok).toBe(false)
  })

  test('the loopback family passes: 127/8, ::1, IPv6-mapped 127.x', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.9.8.7')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::ffff:192.168.0.1')).toBe(false)
    expect(isLoopbackAddress('128.0.0.1')).toBe(false)
  })
})

describe('layer ② Host authority', () => {
  test('rebound attacker domain in Host is rejected (DNS rebinding stopper)', () => {
    expect(guardRequest(fakeReq({ headers: { host: 'evil.example:3080' } })))
      .toEqual({ ok: false, status: 403, code: 'FORBIDDEN_HOST' })
  })

  test('missing Host is rejected', () => {
    expect(guardRequest(fakeReq({ headers: { host: undefined } })).ok).toBe(false)
  })

  test('the loopback name set passes: localhost, [::1] with port', () => {
    expect(guardRequest(fakeReq({ headers: { host: 'localhost:3080' } })).ok).toBe(true)
    expect(guardRequest(fakeReq({ headers: { host: '[::1]:3080' } })).ok).toBe(true)
  })

  test('splitHostAuthority keeps IPv6 brackets and splits the port', () => {
    expect(splitHostAuthority('[::1]:3080')).toEqual({ hostname: '[::1]', port: '3080' })
    expect(splitHostAuthority('127.0.0.1')).toEqual({ hostname: '127.0.0.1', port: '' })
    expect(splitHostAuthority('LOCALHOST:80')).toEqual({ hostname: 'localhost', port: '80' })
  })
})

describe('layer ③ Origin / fetch metadata', () => {
  test('forged non-loopback Origin is rejected', () => {
    expect(guardRequest(fakeReq({ headers: { origin: 'http://evil.example' } })))
      .toEqual({ ok: false, status: 403, code: 'FORBIDDEN_ORIGIN' })
  })

  test('loopback Origin with a different port is not same-origin → rejected', () => {
    expect(guardRequest(fakeReq({ headers: { origin: 'http://127.0.0.1:9999' } })).ok).toBe(false)
  })

  test("the opaque 'null' origin (file://, sandboxed iframe) is rejected", () => {
    expect(guardRequest(fakeReq({ headers: { origin: 'null' } })).ok).toBe(false)
  })

  test('sec-fetch-site: cross-site is rejected even without an Origin', () => {
    expect(guardRequest(fakeReq({ headers: { 'sec-fetch-site': 'cross-site' } })))
      .toEqual({ ok: false, status: 403, code: 'FORBIDDEN_ORIGIN' })
  })

  test('same-origin request passes: matching loopback Origin + benign fetch metadata', () => {
    const req = fakeReq({
      headers: {
        origin: 'http://127.0.0.1:3080',
        'sec-fetch-site': 'same-origin',
      },
    })
    expect(guardRequest(req)).toEqual({ ok: true })
  })

  test('no Origin at all passes (CLI tools / iframe navigation GETs)', () => {
    expect(guardRequest(fakeReq())).toEqual({ ok: true })
  })
})

describe('layer ④ Content-Type gate (no POST endpoint today; branch kept)', () => {
  test('POST without application/json → 415', () => {
    expect(guardRequest(fakeReq({ method: 'POST', headers: { 'content-type': 'text/plain' } })))
      .toEqual({ ok: false, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' })
  })

  test('POST with application/json (charset allowed) passes the guard', () => {
    const req = fakeReq({ method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' } })
    expect(guardRequest(req)).toEqual({ ok: true })
  })

  test('GET never trips the Content-Type gate', () => {
    expect(guardRequest(fakeReq({ headers: { 'content-type': 'text/plain' } })).ok).toBe(true)
  })
})
