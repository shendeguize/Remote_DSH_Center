/**
 * sidebar.footer.action status badge (design §5.1, ADR-3): a colored dot —
 * green (probe passed) / grey (no candidate) / red (candidate exists but the
 * probe fails) — plus the "DSH Center" label in row form. Clicking opens a
 * popover with the discovery details (candidateUrl / source / verified) and
 * the "open the DSH Center tab" pointer. Registration shape and the `wide`
 * owner prop follow the dsh-agent-relay precedent (lib/client-ui.js).
 * Shares the singleton hub store with CenterTab — one probe loop, never two.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { getHubStore, sourceLabel } from './store'
import type { HubState } from './store'

/**
 * Badge dot color (§5.1): green up / red down-with-candidate / grey rest.
 * @param state - shared hub state.
 * @returns CSS color.
 */
function dotColor(state: HubState): string {
  if (state.phase === 'up') return '#22c55e'
  if (state.phase === 'down' && state.candidateUrl !== null) return '#ef4444'
  return '#9ca3af'
}

/**
 * Popover status line for the current phase.
 * @param state - shared hub state.
 * @returns Chinese status text.
 */
function statusText(state: HubState): string {
  switch (state.phase) {
    case 'up': return '运行中（探活通过）'
    case 'down': return state.candidateUrl === null ? '未发现' : '不可达（探活失败）'
    case 'probing': return '探测中…'
    case 'idle': return '未探测'
  }
}

const BUTTON: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 6px',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
  borderRadius: 6,
}
const POPOVER: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 8px)',
  left: 0,
  zIndex: 1000,
  minWidth: 260,
  maxWidth: 320,
  boxSizing: 'border-box',
  padding: '12px 14px',
  borderRadius: 8,
  border: '1px solid rgba(128,128,128,0.4)',
  // System colors track the page's light/dark scheme without a CSS pipeline.
  background: 'Canvas',
  color: 'CanvasText',
  boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
  fontSize: 12,
  lineHeight: 1.7,
  textAlign: 'left',
}
const ROW: CSSProperties = { display: 'flex', gap: 8, justifyContent: 'space-between' }
const KEY: CSSProperties = { opacity: 0.6, flex: 'none' }
const VALUE: CSSProperties = { wordBreak: 'break-all' }
const GUIDE: CSSProperties = {
  marginTop: 8,
  marginBottom: 0,
  paddingTop: 8,
  borderTop: '1px dashed rgba(128,128,128,0.4)',
  opacity: 0.75,
}

/**
 * The footer badge: dot + label trigger, details popover on click.
 * @param props - owner share; `wide` is the rail/row form flag (relay precedent).
 * @returns the badge surface.
 */
export function FooterBadge(props: { wide?: boolean }): ReactElement {
  const store = getHubStore()
  const state = useSyncExternalStore(store.subscribe, store.getState)
  useEffect(() => {
    store.ensureStarted()
  }, [store])
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    function onDown(event: MouseEvent): void {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        style={BUTTON}
        title="DSH Center 状态"
        aria-label="DSH Center 状态"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <span style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: dotColor(state) }} />
        {props.wide === true ? <span>DSH Center</span> : null}
      </button>
      {open
        ? (
            <div style={POPOVER}>
              <div style={ROW}><span style={KEY}>状态</span><span style={VALUE}>{statusText(state)}</span></div>
              <div style={ROW}><span style={KEY}>候选地址</span><span style={VALUE}>{state.candidateUrl ?? '无'}</span></div>
              <div style={ROW}><span style={KEY}>来源</span><span style={VALUE}>{sourceLabel(state.source)}</span></div>
              <div style={ROW}><span style={KEY}>指纹验证</span><span style={VALUE}>{state.verified ? '已通过（host 侧）' : '未通过'}</span></div>
              {state.lastError !== null
                ? <div style={ROW}><span style={KEY}>异常</span><span style={VALUE}>{state.lastError}</span></div>
                : null}
              <p style={GUIDE}>请在会话视图打开「DSH Center」Tab 查看完整面板与降级指引。</p>
            </div>
          )
        : null}
    </div>
  )
}
