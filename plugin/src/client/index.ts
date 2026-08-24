/**
 * dsh-center-hub, browser half (M2).
 *
 * Contributes the "DSH Center" tab to the `conversation.view` ring (the
 * official replace-the-chat-surface slot; kanban/multi-chat precedents) and
 * the status badge to `sidebar.footer.action` (agent-relay precedent). Both
 * surfaces share one hub store (info fetch → Image probe, §5.4).
 *
 * Recursion guard (design §5.3): the Hub's iframe panes embed other dsh web
 * instances which may also carry this plugin — a "dsh web → Hub → dsh web →
 * Hub…" loop. Any page running inside an iframe (`window.self !==
 * window.top`) therefore registers nothing, silently. Side effect (accepted,
 * see README): the tab also stays hidden when dsh web is embedded by other
 * tools.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { CenterTab } from './CenterTab'
import { FooterBadge } from './FooterBadge'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Local restatement of the view-ring declaration owned by the (not yet
     * npm-installable) ui-conversation package: list kind, session scope
     * (r2 §2.3 evidence; registered in README 偏离登记). Type-only — the
     * runtime declaration still comes from the owner at page boot.
     */
    'conversation.view': { kind: 'list'; scope: 'session' }
    /**
     * Local restatement for the sidebar footer action rail: list kind
     * (id/order/label registration), root scope (the footer lives outside
     * any session context), owner passes the rail/row `wide` flag — all
     * grounded in the dsh-agent-relay artifact (lib/client-ui.js), the
     * sidebar.footer.action precedent. Registered in README 偏离登记.
     */
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: { wide?: boolean } }
  }
}

/** Required client service: the slot registry. */
export const inject = ['slots']

/**
 * Whether this page runs inside any iframe (Hub pane, or any other
 * embedder). Such pages must not grow a DSH Center tab of their own.
 * @returns true when framed.
 */
function isEmbedded(): boolean {
  return window.self !== window.top
}

/**
 * Client plugin body: register the view-ring tab and the footer badge
 * unless embedded (the guard runs first, before any registration).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  if (isEmbedded()) return
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'dsh-center',
    order: 30,
    label: 'DSH Center',
  }, CenterTab))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-center',
    order: 120,
    label: 'DSH Center',
  }, FooterBadge))
}
