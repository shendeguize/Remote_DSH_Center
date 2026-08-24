/**
 * Browser-half tsdown preset — replicates the closure-factory artifact of
 * dsh-web-ui `shared/tsdown.client.ts` (the only known-good blueprint; the
 * official clientBundle preset is unpublished). The bundle registers itself
 * via `window.__ModuleLoader__.load({ id, factory: (require) => ... })` and
 * resolves the frozen platform modules through the injected require; every
 * other dependency is inlined (a require() the loader table cannot answer is
 * a guaranteed runtime throw).
 *
 * Trimmed vs the blueprint (M1-irrelevant parts, registered in README
 * 实现笔记/偏离登记): CSS-Modules inline pipeline, INLINE_SAFE/GENERATED_REMOTE
 * purity-gate allowances, the dsh-client-runtime store exemption external,
 * sourcemap path rebasing, and the DSH_BUILD_FACE two-pass workspace switch.
 */
import type { UserConfig } from 'tsdown'

/**
 * Frozen platform module table — mirrors the shell's seed table
 * (dsh-web-ui `shared/web-platform.ts`, verified against the 0.1.1-rc.2 dist).
 */
export const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES]

/**
 * Build the browser-half config for one plugin id.
 * @param id - plugin id (package name), stamped into the loader handoff.
 * @returns tsdown config emitting exactly `lib/client.js` (+ sourcemap).
 */
export function clientConfig(id: string): UserConfig {
  return {
    name: `${id}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    // dts would wrap the banner/footer into .d.cts and break parsing.
    dts: false,
    sourcemap: true,
    // clean must stay off — a default clean would wipe the node-half output.
    clean: false,
    external: [...CLIENT_EXTERNALS],
    // zustand/immer-style deps read process.env.NODE_ENV / import.meta.env at
    // module scope; a CJS browser bundle carries neither, so substitute all
    // three keys (blueprint rationale, tsdown.client.ts:239-243).
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    // Reverse rule: no opinion for table entries (external wins), inline
    // everything else.
    noExternal: (moduleId: string) => (CLIENT_EXTERNALS.includes(moduleId) ? undefined : true),
    plugins: [{
      // Bundle purity gate: any @deepseek-ai value import outside the frozen
      // table is a build error — it would either duplicate a runtime instance
      // or require a specifier the loader table cannot answer. Type-only
      // imports are erased and never reach this gate.
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (CLIENT_EXTERNALS.includes(source)) return null
        throw new Error(
          `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS) — `
          + 'cross-plugin value imports are forbidden; collaborate through cordis services',
        )
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}
