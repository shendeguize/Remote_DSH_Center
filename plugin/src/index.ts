/**
 * dsh-center-hub, host half.
 *
 * Named-export foursome (name/inject/Config/apply) — a default export would
 * make the Loader drop `inject` (ecosystem postmortem 0001). Deliberately
 * minimal (design §4): a one-shot manager discovery (config >
 * $DSHC_HOME/config.json > factory-candidate probe, verified by the
 * /api/manager/info readback) and one guarded read-only info route on the
 * host webserver. No spawn, no proxy, no resident polling.
 * @module dsh-center-hub
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createDiscovery } from './discovery'
import { registerInfoRoute } from './routes'

/** Stable Cordis plugin name. */
export const name = 'dsh-center-hub'

/**
 * Hard service dependency: the discovery info route registers on the
 * webserver, so the plugin waits for the service instead of polling.
 */
export const inject = ['webServer']

/** Plugin config (deployment shape only — design §6.1, two fields total). */
export interface CenterHubConfig {
  /**
   * Browser-reachable manager address (e.g. `http://127.0.0.1:7788`).
   * Empty (default) means auto-discovery on the dsh host machine.
   */
  managerUrl?: string
  /**
   * DSH Center home directory for config.json discovery. Empty (default)
   * follows the `DSHC_HOME` environment variable and the factory home
   * (`~/.dsh_center/`).
   */
  dshcHome?: string
}

/** Schema-validated config (the Loader resolves defaults for absent keys). */
export const Config = z.object({
  managerUrl: z.string().default(''),
  dshcHome: z.string().default(''),
})

/**
 * Plugin body: wire the cached discovery to the guarded info route. The
 * route disposer lives in `ctx.effect` (torn down with the fiber); the
 * discovery cache holds no timers, so there is nothing else to dispose.
 * @param ctx - cordis host context.
 * @param config - schema-resolved plugin config.
 */
export function apply(ctx: Context, config: CenterHubConfig = {}): void {
  const discovery = createDiscovery({
    managerUrl: config.managerUrl,
    dshcHome: config.dshcHome,
  })
  registerInfoRoute(ctx, discovery)
  ctx.logger.info(
    `dsh-center-hub ready (managerUrl=${config.managerUrl === undefined || config.managerUrl === '' ? 'auto' : config.managerUrl})`,
  )
}
