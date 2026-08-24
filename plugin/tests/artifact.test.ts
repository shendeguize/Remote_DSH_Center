/**
 * Built-artifact shape: lib/client.js must be a loader-recognizable lazy-CJS
 * closure factory (banner/footer/intro trio). `npm run verify` builds before
 * testing so this suite always runs there; a bare `npm test` on a fresh
 * checkout skips it instead of failing on a missing artifact.
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const clientJs = new URL('../lib/client.js', import.meta.url)
const indexJs = new URL('../lib/index.js', import.meta.url)

describe.skipIf(!existsSync(clientJs))('lib/client.js lazy-CJS factory', () => {
  const source = readFileSync(clientJs, 'utf8')

  test('starts with the __ModuleLoader__.load banner for this plugin id', () => {
    // tsdown 0.22 reprints banner/footer with the chunk (same formatting as
    // the blueprint repo's own committed lib/client.js artifacts), so match
    // structurally rather than byte-for-byte.
    expect(source.slice(0, 200)).toMatch(
      /^window\.__ModuleLoader__\.load\(\{\s*id: "dsh-center-hub",\s*factory: \(require\) => \{/,
    )
  })

  test('carries the intro and footer of the closure-factory trio', () => {
    expect(source).toContain('var module = { exports: {} };')
    expect(source).toMatch(/return module\.exports;\s*\}\s*\}\);/)
  })

  test('platform modules resolve through require, not inlined copies', () => {
    expect(source).toMatch(/require\((["'])react\/jsx-runtime\1\)/)
  })
})

describe.skipIf(!existsSync(indexJs))('lib/index.js host half', () => {
  test('exports the foursome as ESM named exports', () => {
    const source = readFileSync(indexJs, 'utf8')
    for (const symbol of ['name', 'inject', 'Config', 'apply']) {
      expect(source).toMatch(new RegExp(`export\\s*\\{[^}]*\\b${symbol}\\b`))
    }
  })
})
