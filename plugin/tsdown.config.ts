/**
 * Build config for dsh-center-hub: two halves, one `tsdown` invocation.
 *   - lib/index.js (+ index.d.ts): host half, ESM for the dsh Loader.
 *   - lib/client.js: browser half, lazy-CJS closure factory (see
 *     ./tsdown.client.ts for the blueprint provenance).
 */
import { defineConfig } from 'tsdown'
import { clientConfig } from './tsdown.client.ts'

const id = 'dsh-center-hub'

export default defineConfig([
  {
    name: id,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    // Plain .js/.d.ts extensions — the exports map points at lib/index.js
    // and lib/index.d.ts (blueprint clientLibraryConfig same setting).
    fixedExtension: false,
    // Flat lib/index.d.ts — the exports map's "types" condition points there.
    dts: true,
    clean: false,
    // Peer/runtime deps resolve from the dsh profile tree at runtime, never
    // from this repo's install; they must stay external.
    external: ['@deepseek-ai/cordis', '@deepseek-ai/schemastery'],
  },
  clientConfig(id),
])
