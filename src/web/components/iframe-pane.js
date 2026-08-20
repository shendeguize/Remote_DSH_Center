/**
 * iframe keep-alive registry 与断联遮罩（10 §3.4 / UI-14、UI-15）。
 *
 * 决策逻辑（paneDecision）是纯函数，单测直接覆盖 reload 语义：
 * degraded 往返不 reload、crashed 恢复只 reload 一次、localPort 变化必须重建。
 */

import { ACTION_LABEL, button, el, phaseMeta } from '../utils.js';

/** 有 iframe 意义的三态之外都不该留着 pane。 */
const KEEP_PHASES = new Set(['running', 'degraded', 'crashed', 'starting']);

/**
 * @param {{mappedUrl:string|null, localPort:number|null, phase:string, sawCrash:boolean}|null} prev
 * @param {{mappedUrl:string|null, localPort:number|null, phase:string}} next
 * @returns {{kind:'none'|'create'|'recreate'|'reload'|'destroy', reason:string}}
 */
export function paneDecision(prev, next) {
  if (!KEEP_PHASES.has(next.phase)) {
    // 主动关停到 ready，或主机被禁用/移除：释放会话资源（10 §3.4）
    return prev ? { kind: 'destroy', reason: `phase=${next.phase}` } : { kind: 'none', reason: 'no-pane' };
  }
  if (!next.mappedUrl) {
    // starting / crashed 时隧道可能还没起来：留住已有文档，只挂遮罩
    return prev ? { kind: 'none', reason: 'no-url-keep' } : { kind: 'none', reason: 'no-url-yet' };
  }
  if (!prev) return { kind: 'create', reason: 'first-url' };

  if (prev.localPort !== null && next.localPort !== prev.localPort) {
    // 旧文档与 WebSocket 都绑在旧 origin 上，只能整只换掉
    return { kind: 'recreate', reason: 'local-port-changed' };
  }
  if (prev.mappedUrl !== next.mappedUrl) return { kind: 'recreate', reason: 'mapped-url-changed' };

  // crashed → running：远端进程换了新的，页面里的会话已失效，reload 一次
  if (next.phase === 'running' && prev.sawCrash) return { kind: 'reload', reason: 'crash-recovered' };
  // degraded → running：隧道自己回来了，交给 dsh web 的 WebSocket 自愈
  return { kind: 'none', reason: 'keep-alive' };
}

/** 遮罩内容（纯函数）：null = 不显示遮罩。 */
export function overlayFor(host) {
  if (!host) return { title: '主机已消失', body: '该主机已不在 manager 的清单中。', action: null };
  switch (host.phase) {
    case 'degraded':
      return { title: '隧道断开，manager 正在重连', body: host.tunnel?.suspendedReason ? '重连已暂停，需人工处理。' : '页面内容仍是上次加载的快照。', action: 'reconnect' };
    case 'crashed':
      return { title: '远端 dsh web 已退出', body: '重启后页面会自动重新载入。', action: 'restart' };
    case 'starting':
      return { title: '正在启动…', body: '拉起远端 dsh web 并建立隧道。', action: null };
    case 'running':
      return host.mappedUrl ? null : { title: '等待隧道就绪', body: '映射地址尚未下发。', action: null };
    default:
      return { title: `当前状态：${phaseMeta(host.phase).label}`, body: '此状态没有可用的页面。', action: null };
  }
}

export function createIframePanes({ store, actions }) {
  const root = el('div.iframe-stack');
  // 还没有可用映射地址（starting / crashed 且隧道已关）时，页面区只放遮罩
  const placeholder = el('section.iframe-pane.is-placeholder', { hidden: true }, [el('div.iframe-overlay')]);
  root.append(placeholder);
  /** @type {Map<string, {section:HTMLElement, frame:HTMLIFrameElement, overlay:HTMLElement, snap:object}>} */
  const panes = new Map();

  function snapshotOf(host, sawCrash) {
    return {
      mappedUrl: host.mappedUrl ?? null,
      localPort: host.tunnel?.localPort ?? null,
      phase: host.phase,
      sawCrash,
    };
  }

  function build(host) {
    const frame = el('iframe', {
      title: `DSH Web — ${host.name}`,
      referrerpolicy: 'no-referrer',
      src: host.mappedUrl,
    });
    const overlay = el('div.iframe-overlay', { hidden: true });
    const section = el('section.iframe-pane', { dataset: { host: host.name }, hidden: true }, [frame, overlay]);
    root.append(section);
    // 崩溃态下打开的 pane 要记住「见过 crashed」，恢复时才会 reload 一次
    const pane = { section, frame, overlay, snap: snapshotOf(host, host.phase === 'crashed') };
    panes.set(host.name, pane);
    return pane;
  }

  function destroy(name) {
    panes.get(name)?.section.remove();
    panes.delete(name);
  }

  function renderOverlay(pane, host) {
    const spec = overlayFor(host);
    if (!spec) {
      pane.overlay.hidden = true;
      return;
    }
    pane.overlay.hidden = false;
    pane.overlay.replaceChildren(
      el('h2', { text: spec.title }),
      el('p', { text: spec.body }),
      el('div.overlay-actions', {}, [
        spec.action
          ? button(spec.action === 'reconnect' ? '立即重连' : ACTION_LABEL[spec.action], {
            variant: 'primary',
            compact: false,
            disabled: store.hostBusy(host.name) || !store.canWrite(),
            onClick: () => actions.hostAction(spec.action, host.name),
          })
          : null,
        el('a.link', { href: '#/', text: '返回管理台' }),
      ]),
    );
  }

  /**
   * 按当前 host 视图同步某台主机的 pane。
   * @param {string} name
   * @param {{force?:boolean}} [opts] force=true 表示即使没 pane 也要按需创建（用户主动打开）
   */
  function sync(name, { force = false } = {}) {
    const host = store.getHost(name);
    const pane = panes.get(name) ?? null;
    if (!host) {
      destroy(name);
      return null;
    }

    const next = snapshotOf(host, false);
    const decision = paneDecision(pane?.snap ?? null, next);

    if (decision.kind === 'destroy') {
      destroy(name);
      return null;
    }
    if (decision.kind === 'create') {
      if (!force && !panes.has(name)) return null; // 后台主机延迟到首次打开才建 iframe（10 §5.3）
      const created = build(host);
      renderOverlay(created, host);
      return created;
    }
    if (!pane) return null;

    if (decision.kind === 'recreate') {
      destroy(name);
      const rebuilt = build(host);
      renderOverlay(rebuilt, host);
      if (decision.reason === 'local-port-changed') {
        store.addToast({ level: 'warn', summary: `${name} 映射端口已变更，页面已重新载入` });
      }
      return rebuilt;
    }
    if (decision.kind === 'reload') {
      reloadFrame(pane.frame);
    }

    // sawCrash 只在「见过 crashed 且还没 reload」期间为真，保证只 reload 一次
    pane.snap = {
      ...next,
      sawCrash: host.phase === 'crashed' ? true : (decision.kind === 'reload' ? false : pane.snap.sawCrash),
    };
    renderOverlay(pane, host);
    return pane;
  }

  function reloadFrame(frame) {
    try {
      frame.contentWindow.location.reload();
    } catch {
      frame.src = frame.src; // eslint-disable-line no-self-assign -- 跨源时唯一可用的重载手段
    }
  }

  /** 路由切换只改显隐，绝不动 src（keep-alive 的关键）。 */
  function show(name) {
    if (name && !panes.has(name)) sync(name, { force: true });
    for (const [host, pane] of panes) {
      const active = host === name;
      pane.section.hidden = !active;
      pane.section.setAttribute('aria-hidden', String(!active));
    }

    // 目标主机还没 iframe（隧道未就绪）：用占位遮罩顶上，别把用户丢在空白页
    const bare = name !== null && !panes.has(name);
    placeholder.hidden = !bare;
    if (bare) renderOverlay({ overlay: placeholder.firstChild }, store.getHost(name));
    root.hidden = name === null;
  }

  const offs = [
    store.on('hosts:changed', (name) => {
      sync(name);
      if (store.state.route.kind === 'host' && store.state.route.host === name) show(name);
    }),
    store.on('hosts:reset', () => {
      for (const name of [...panes.keys()]) sync(name);
    }),
    store.on('pending:changed', () => {
      for (const [name, pane] of panes) {
        const host = store.getHost(name);
        if (host) renderOverlay(pane, host);
      }
    }),
    store.on('connection:changed', () => {
      for (const [name, pane] of panes) {
        const host = store.getHost(name);
        if (host) renderOverlay(pane, host);
      }
    }),
  ];

  return {
    root,
    show,
    sync,
    has: (name) => panes.has(name),
    openedHosts: () => [...panes.keys()],
    destroy() {
      for (const off of offs) off();
      for (const name of [...panes.keys()]) destroy(name);
    },
  };
}
