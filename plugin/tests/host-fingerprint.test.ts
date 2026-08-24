/**
 * Fingerprint readback discipline (design §4.2): real `node:http` servers on
 * 127.0.0.1 ephemeral ports play the four verdict lanes — correct
 * fingerprint, HTTP 200 with the wrong fingerprint, port mismatch inside the
 * JSON, and timeout. "HTTP 200 ≠ the target app": only a JSON body carrying
 * `version` plus a `port` equal to the dialed port verifies.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { discover, probeManagerInfo } from '../src/discovery'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

const servers: http.Server[] = []
const tempDirs: string[] = []

/** Start a throwaway loopback server; closed in afterEach. */
async function listen(handler: Handler): Promise<number> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return (server.address() as AddressInfo).port
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop() as http.Server
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  }
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true })
})

/** Respond JSON on any request. */
function jsonHandler(body: unknown, status = 200): Handler {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
}

describe('probeManagerInfo verdicts', () => {
  test('correct fingerprint verifies and yields exactly version/port', async () => {
    const port = await listen((req, res) => {
      expect(req.url).toBe('/api/manager/info')
      jsonHandler({ version: '0.2.0', port, pid: 4242, mode: 'daemon' })(req, res)
    })
    const fingerprint = await probeManagerInfo({ hostname: '127.0.0.1', port })
    expect(fingerprint).toEqual({ version: '0.2.0', port })
  })

  test('HTTP 200 with a non-manager body is not a discovery', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>definitely not a manager</html>')
    })
    expect(await probeManagerInfo({ hostname: '127.0.0.1', port })).toBeNull()
  })

  test('HTTP 200 JSON missing the version field is not a discovery', async () => {
    const port = await listen(jsonHandler({ port: 0 }))
    const target = { hostname: '127.0.0.1', port }
    expect(await probeManagerInfo(target)).toBeNull()
  })

  test('port mismatch inside the JSON fails the fingerprint', async () => {
    const port = await listen(jsonHandler({ version: '0.2.0', port: 1 }))
    expect(await probeManagerInfo({ hostname: '127.0.0.1', port })).toBeNull()
  })

  test('non-200 status is not a discovery', async () => {
    const port = await listen(jsonHandler({ version: '0.2.0', port: 7788 }, 503))
    expect(await probeManagerInfo({ hostname: '127.0.0.1', port })).toBeNull()
  })

  test('a server that never answers resolves null within the timeout bound', async () => {
    const port = await listen(() => { /* hold the request open */ })
    const started = Date.now()
    const fingerprint = await probeManagerInfo({ hostname: '127.0.0.1', port }, { timeoutMs: 150 })
    expect(fingerprint).toBeNull()
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  test('connection refused resolves null', async () => {
    const port = await listen(jsonHandler({}))
    const server = servers.pop() as http.Server
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
    expect(await probeManagerInfo({ hostname: '127.0.0.1', port })).toBeNull()
  })
})

describe('discover with the real prober (end to end, offline)', () => {
  test('configFile port + live fake manager → verified with readback digest', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-center-hub-test-'))
    tempDirs.push(home)
    const port = await listen((req, res) => {
      jsonHandler({ version: '9.9.9', port, extra: 'never leaks' })(req, res)
    })
    writeFileSync(join(home, 'config.json'), JSON.stringify({ manager: { port } }))
    const result = await discover({ dshcHome: home, env: {} })
    expect(result).toEqual({
      candidateUrl: `http://127.0.0.1:${port}`,
      source: 'configFile',
      verified: true,
      manager: { version: '9.9.9', port },
    })
  })
})
