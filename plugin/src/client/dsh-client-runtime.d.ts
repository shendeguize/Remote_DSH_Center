/**
 * Local ambient shim (M1 deviation, registered in README 实现笔记/偏离登记):
 * `@deepseek-ai/dsh-client-runtime@0.0.1-rc.1` cannot be installed from the
 * registry — its published dependency list references the unpublished
 * `@deepseek-ai/dsh-compact` (404). The plugin only needs the ClientContext
 * type at compile time (the browser import is type-only and erased from the
 * bundle), so the M1 surface is declared here structurally, grounded in the
 * published `@deepseek-ai/dsh-client-ui-slots` SlotCore contract plus the
 * `slots.inject` wrapper usage proven by the kanban/multi-chat reference
 * plugins. Replace with the real SDK types once an installable runtime
 * package ships.
 */
declare module '@deepseek-ai/dsh-client-runtime/client' {
  import type { SlotCore, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'

  /**
   * The runtime Service wrapper around the pure SlotCore: `inject` defers the
   * register call until the target slot's owner has declared it (and
   * re-registers across declaration epochs), managing the disposer returned
   * by the callback.
   */
  interface SlotsService extends SlotCore {
    inject<K extends keyof SlotMap & string>(slot: K, register: () => () => void): void
  }

  /** Client root context — M1 surface only. */
  export interface ClientContext {
    slots: SlotsService
    effect(callback: () => unknown, label?: string): unknown
  }
}
