/**
 * The "DSH Center" tab body (M2, design §5.1/5.2/5.4): the shared hub store
 * (info fetch → Image probe) drives one of three surfaces — a probing
 * notice, the full-panel Hub iframe once the probe passes, or the
 * three-state degradation card (§6.2/6.3 copy) when it does not.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { classify, getHubStore, sourceLabel } from './store'
import type { HubState } from './store'

// Inline styles only (design §5.1 allows inline / minimal style injection;
// the blueprint's CSS-Modules pipeline was trimmed in M1).
const PANEL: CSSProperties = {
  height: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
}
const CARD: CSSProperties = {
  maxWidth: 560,
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid rgba(128,128,128,0.35)',
  borderRadius: 10,
  padding: '20px 24px',
  fontSize: 13,
  lineHeight: 1.8,
}
const TITLE: CSSProperties = { margin: 0, fontSize: 16, fontWeight: 650 }
const BODY: CSSProperties = { marginTop: 10, marginBottom: 0, opacity: 0.85 }
const HINT: CSSProperties = { marginTop: 8, marginBottom: 0, opacity: 0.65 }
const RETRY: CSSProperties = {
  marginTop: 14,
  padding: '5px 14px',
  fontSize: 13,
  cursor: 'pointer',
  border: '1px solid rgba(128,128,128,0.5)',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
}

/**
 * Centered card chrome shared by the probing notice and degradation cards.
 * @param props - title, optional retry handler, body content.
 * @returns the card surface.
 */
function Card(props: { title: string; onRetry?: () => void; children: ReactNode }): ReactElement {
  return (
    <div style={PANEL}>
      <div style={CARD}>
        <h2 style={TITLE}>{props.title}</h2>
        {props.children}
        {props.onRetry !== undefined
          ? <button type="button" style={RETRY} onClick={props.onRetry}>重试</button>
          : null}
      </div>
    </div>
  )
}

/**
 * The three-state degradation card (§5.2 ①②③, remote copy per §6.2/6.3).
 * @param props - down-phase store state plus the retry handler.
 * @returns the card matching the classify() verdict.
 */
function DegradedCard(props: { state: HubState; onRetry: () => void }): ReactElement {
  const { state } = props
  const verdict = classify(state, false)
  if (verdict === 'no-candidate') {
    // Card ①: no candidate at all (host found nothing, no managerUrl).
    return (
      <Card title="未发现 DSH Center" onRetry={props.onRetry}>
        <p style={BODY}>
          若已安装，请确认 <code>dshc up</code> 正在<strong>浏览器所在机器</strong>运行。
        </p>
        <p style={HINT}>
          远端场景：这是远端 dsh 实例时，host 半区探测不到你本机的 manager——请在该
          profile 的插件配置里显式填 <code>managerUrl</code>（浏览器可达的 manager
          地址，通常 <code>http://127.0.0.1:7788</code>）。
        </p>
        {state.lastError !== null
          ? <p style={HINT}>发现路由异常：{state.lastError}</p>
          : null}
      </Card>
    )
  }
  const origin = (
    <>候选地址 <code>{state.candidateUrl}</code>（来源：{sourceLabel(state.source)}）</>
  )
  if (verdict === 'mismatch') {
    // Card ③: host verified a manager, but the browser cannot reach it —
    // the remote-collision case (§6.3 copy).
    return (
      <Card title="发现的 Center 不是你本机的 Center" onRetry={props.onRetry}>
        <p style={BODY}>
          dsh 主机上发现的 Center 不是你本机的 Center（或不可达）：{origin}已通过
          host 侧指纹验证，但浏览器探活失败——iframe 的 <code>127.0.0.1</code> 解析于
          <strong>浏览器所在机器</strong>，两者只在本机 dsh 场景重合。
        </p>
        <p style={HINT}>
          若这是远端 dsh，请在其插件配置里把 <code>managerUrl</code> 指向浏览器可达的
          manager；若想用本机 Center，请先在本机运行 <code>dshc up</code>。
        </p>
      </Card>
    )
  }
  // Card ②: a candidate exists but the probe fails (verified false).
  return (
    <Card title="无法连接 DSH Center" onRetry={props.onRetry}>
      <p style={BODY}>{origin}探活失败。</p>
      <p style={HINT}>
        请在<strong>浏览器所在机器</strong>启动 manager：<code>dshc up</code>。失败后会按
        5s→60s 的有界退避自动重探，也可点「重试」立即重探。
      </p>
    </Card>
  )
}

/**
 * The tab body: mounts the shared store flow and renders iframe / probing
 * notice / degradation card by phase.
 * @returns the panel surface.
 */
export function CenterTab(): ReactElement {
  const store = getHubStore()
  const state = useSyncExternalStore(store.subscribe, store.getState)
  useEffect(() => {
    store.ensureStarted()
  }, [store])
  if (state.phase === 'up' && state.candidateUrl !== null) {
    // No sandbox by design (§5.2): the Hub and dsh web belong to the same
    // local loopback trust domain (multi-chat embeds sibling dsh instances
    // with the same bare iframe); sandboxing would cripple the Hub's own
    // scripts. Rendered only after the Image probe passed — no about:blank
    // pre-mount, no speculative connection.
    return (
      <iframe
        src={state.candidateUrl}
        title="DSH Center Hub"
        loading="lazy"
        style={{ display: 'block', width: '100%', height: '100%', border: 'none' }}
      />
    )
  }
  if (state.phase === 'idle' || state.phase === 'probing') {
    return (
      <Card title="DSH Center">
        <p style={BODY}>正在探测本机 manager…</p>
      </Card>
    )
  }
  return <DegradedCard state={state} onRetry={() => { store.retry() }} />
}
