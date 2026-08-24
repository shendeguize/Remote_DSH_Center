/**
 * Manifest consistency: the dsh manifest triple, the cordis.patch.yml ↔
 * package.json name agreement, and the host-half named-export foursome with
 * schemastery defaults.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { Config, apply, inject, name } from '../src/index'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('dsh manifest triple (package.json)', () => {
  test('engines.dsh uses the only supported ">=" form', () => {
    expect(pkg.dsh.engines.dsh).toMatch(/^>=\d+\.\d+\.\d+(-rc\.\d+)?$/)
  })

  test('bundle.patch points at the shipped cordis.patch.yml', () => {
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.files).toContain('cordis.patch.yml')
  })

  test('client block declares the web platform and its inject list', () => {
    expect(pkg.dsh.client.platform).toBe('web')
    expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-slots')
    expect(pkg.exports['./client'].default).toBe('./lib/client.js')
  })
})

describe('cordis.patch.yml ↔ package.json', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

  test('patch id and name match the npm package name', () => {
    expect(pkg.name).toBe('dsh-center-hub')
    expect(patch).toMatch(new RegExp(`^\\s*-\\s*id:\\s*${pkg.name}$`, 'm'))
    expect(patch).toMatch(new RegExp(`^\\s*name:\\s*'${pkg.name}'$`, 'm'))
  })

  test('patch deliberately carries no config block (schemastery defaults win)', () => {
    expect(patch).not.toMatch(/^\s*config:/m)
  })
})

describe('host half named exports', () => {
  test('foursome shape: name/inject/Config/apply', () => {
    expect(name).toBe(pkg.name)
    expect(inject).toEqual(['webServer'])
    expect(typeof apply).toBe('function')
    expect(typeof Config).toBe('function')
  })

  test('Config resolves the two documented defaults', () => {
    expect(Config({})).toEqual({ managerUrl: '', dshcHome: '' })
  })

  test('Config passes explicit values through and rejects wrong types', () => {
    expect(Config({ managerUrl: 'http://127.0.0.1:7788' }).managerUrl).toBe('http://127.0.0.1:7788')
    expect(() => Config({ managerUrl: 42 as unknown as string })).toThrow()
  })
})
