/**
 * iframe keep-alive registry 与断联遮罩（10 §3.4 / UI-14、UI-15）。
 *
 * 决策逻辑（paneDecision）是纯函数，单测直接覆盖 reload 语义：
 * degraded 往返不 reload、crashed 恢复只 reload 一次、localPort 变化必须重建。
 */

import { isHostActionAllowed } from '../host-rules.js';
import { ACTION_LABEL, button, el, phaseMeta } from '../utils.js';

/** 有 iframe 意义的三态之外都不该留着 pane。 */
const KEEP_PHASES = new Set(['running', 'degraded', 'crashed', 'starting']);

/** tab 与懒建 panel 共用的稳定 ID；编码后不含空白，任意合法主机名都可直接落进 id。 */
export function hostTabId(name) {
  return `host-tab-${encodeURIComponent(String(name))}`;
}

export function hostPanelId(name) {
  return `host-panel-${encodeURIComponent(String(name))}`;
}

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

function startingOverlay(host) {
  return {
    title: '正在启动…',
    body: host?.local === true ? '正在本机拉起 dsh web。' : '拉起远端 dsh web 并建立隧道。',
    action: null,
  };
}

/** 遮罩内容（纯函数）：null = 不显示遮罩；startPending 只是一层视图投影。 */
export function overlayFor(host, { startPending = false } = {}) {
  if (!host) return { title: '主机已消失', body: '该主机已不在 manager 的清单中。', action: null };
  if (startPending && host.phase === 'ready') return startingOverlay(host);
  const local = host.local === true;
  switch (host.phase) {
    case 'degraded': {
      const canReconnect = isHostActionAllowed(host, 'reconnect');
      return {
        title: local ? '本机页面连接中断，manager 正在恢复' : '隧道断开，manager 正在重连',
        body: host.tunnel?.suspendedReason
          ? '重连已暂停，需人工处理。'
          : canReconnect
            ? '页面内容仍是上次加载的快照。'
            : '页面内容仍是上次加载的快照；请回管理台手动处理。',
        action: canReconnect ? 'reconnect' : null,
      };
    }
    case 'crashed': {
      const canRestart = isHostActionAllowed(host, 'restart');
      return {
        title: local ? '本机 dsh web 已退出' : '远端 dsh web 已退出',
        body: canRestart ? '重启后页面会自动重新载入。' : '该实例不是本工具拉起的，请回管理台手动处理。',
        action: canRestart ? 'restart' : null,
      };
    }
    case 'starting':
      return startingOverlay(host);
    case 'running':
      return host.mappedUrl
        ? null
        : {
          title: local ? '等待本机页面就绪' : '等待隧道就绪',
          body: local ? '访问地址尚未下发。' : '映射地址尚未下发。',
          action: null,
        };
    default:
      return { title: `当前状态：${phaseMeta(host.phase).label}`, body: '此状态没有可用的页面。', action: null };
  }
}

export function loadingText(host) {
  return host?.local === true ? '正在加载本机页面…' : '正在加载远端页面…';
}

export function createIframePanes({ store, actions }) {
  const root = el('div.iframe-stack');
  // 还没有可用映射地址（starting / crashed 且隧道已关）时，页面区只放遮罩
  const placeholderOverlay = el('div.iframe-overlay', {
    role: 'status',
    'aria-live': 'polite',
    'aria-busy': 'false',
    tabindex: '-1',
  });
  const placeholder = el('section.iframe-pane.is-placeholder', {
    hidden: true,
    role: 'tabpanel',
    'aria-hidden': 'true',
  }, [placeholderOverlay]);
  root.append(placeholder);
  /** @type {Map<string, {section:HTMLElement, frame:HTMLIFrameElement, loading:HTMLElement, overlay:HTMLElement, loaded:boolean, snap:object}>} */
  const panes = new Map();
  let pendingStatusFocus = null;

  function snapshotOf(host, sawCrash) {
    return {
      mappedUrl: host.mappedUrl ?? null,
      localPort: host.tunnel?.localPort ?? null,
      phase: host.phase,
      sawCrash,
    };
  }

  function build(host) {
    let pane = null;
    const frame = el('iframe', {
      title: `DSH Web — ${host.name}`,
      referrerpolicy: 'no-referrer',
      src: host.mappedUrl,
      on: {
        load: () => {
          if (!pane) return;
          pane.loaded = true;
          pane.loading.hidden = true;
          pane.loading.setAttribute('aria-busy', 'false');
        },
      },
    });
    const loading = el('div.iframe-loading', {
      role: 'status',
      'aria-live': 'polite',
      'aria-busy': 'true',
      tabindex: '-1',
    }, [
      el('p', { text: loadingText(host) }),
    ]);
    const overlay = el('div.iframe-overlay', {
      hidden: true,
      role: 'status',
      'aria-live': 'polite',
      'aria-busy': 'false',
      tabindex: '-1',
    });
    const section = el('section.iframe-pane', {
      id: hostPanelId(host.name),
      dataset: { host: host.name },
      hidden: true,
      role: 'tabpanel',
      'aria-labelledby': hostTabId(host.name),
      'aria-hidden': 'true',
    }, [frame, loading, overlay]);
    root.append(section);
    // 崩溃态下打开的 pane 要记住「见过 crashed」，恢复时才会 reload 一次
    pane = {
      section,
      frame,
      loading,
      overlay,
      loaded: false,
      snap: snapshotOf(host, host.phase === 'crashed'),
    };
    panes.set(host.name, pane);
    return pane;
  }

  function destroy(name) {
    panes.get(name)?.section.remove();
    panes.delete(name);
  }

  function renderOverlay(pane, host) {
    const startPending = host?.phase === 'ready' && store.isPending('start', host.name);
    const spec = overlayFor(host, { startPending });
    if (!spec) {
      pane.overlay.hidden = true;
      pane.overlay.setAttribute('aria-busy', 'false');
      if (pane.loading) {
        pane.loading.hidden = pane.loaded;
        pane.loading.setAttribute('aria-busy', String(!pane.loaded));
      }
      return;
    }
    // 后端 phase 是唯一失败事实源；它的遮罩永远优先于仅表示首载进度的 loading。
    if (pane.loading) pane.loading.hidden = true;
    pane.overlay.hidden = false;
    pane.overlay.setAttribute('aria-busy', String(host?.phase === 'starting' || startPending));
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
        el('a.link', { href: '#/hub', text: '回到起始页' }),
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
      reloadFrame(pane);
    }

    // sawCrash 只在「见过 crashed 且还没 reload」期间为真，保证只 reload 一次
    pane.snap = {
      ...next,
      sawCrash: host.phase === 'crashed' ? true : (decision.kind === 'reload' ? false : pane.snap.sawCrash),
    };
    renderOverlay(pane, host);
    return pane;
  }

  function reloadFrame(pane) {
    pane.loaded = false;
    pane.loading.hidden = false;
    pane.loading.setAttribute('aria-busy', 'true');
    try {
      pane.frame.contentWindow.location.reload();
    } catch {
      pane.frame.src = pane.frame.src; // eslint-disable-line no-self-assign -- 跨源时唯一可用的重载手段
    }
  }

  /** 路由切换只改显隐，绝不动 src（keep-alive 的关键）。 */
  function show(name) {
    const carryPlaceholderFocus = name !== null
      && placeholder.dataset.host === name
      && document.activeElement === placeholderOverlay;
    const routeHost = store.state.route.kind === 'host' ? store.state.route.host : null;
    if (pendingStatusFocus !== null && pendingStatusFocus !== name && pendingStatusFocus !== routeHost) {
      pendingStatusFocus = null;
    }
    if (name && !panes.has(name)) sync(name, { force: true });
    for (const [host, pane] of panes) {
      const active = host === name;
      pane.section.hidden = !active;
      pane.section.setAttribute('aria-hidden', String(!active));
    }

    // 目标主机还没 iframe（隧道未就绪）：用占位遮罩顶上，别把用户丢在空白页
    const bare = name !== null && !panes.has(name);
    placeholder.hidden = !bare;
    placeholder.setAttribute('aria-hidden', String(!bare));
    if (bare) {
      placeholder.dataset.host = name;
      placeholder.setAttribute('id', hostPanelId(name));
      placeholder.setAttribute('aria-labelledby', hostTabId(name));
      renderOverlay({ overlay: placeholderOverlay }, store.getHost(name));
    } else {
      delete placeholder.dataset.host;
      placeholder.removeAttribute('id');
      placeholder.removeAttribute('aria-labelledby');
    }
    root.hidden = name === null;

    if (name !== null && (pendingStatusFocus === name || carryPlaceholderFocus)) {
      const pane = panes.get(name);
      const status = pane && !pane.section.hidden
        ? (!pane.overlay.hidden ? pane.overlay : (!pane.loading.hidden ? pane.loading : null))
        // ready + start pending 的占位虽已可见，但键盘焦点仍等 SSE starting 真相到达
        // 再转交；这样请求失败时不会把焦点送进随即消失的临时状态区。
        : (bare && store.getHost(name)?.phase !== 'ready' ? placeholderOverlay : null);
      if (status) {
        pendingStatusFocus = null;
        status.focus();
      }
    }
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
      const placeholderHost = placeholder.dataset.host;
      if (placeholderHost) renderOverlay({ overlay: placeholderOverlay }, store.getHost(placeholderHost));
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
    focusStatusWhenAvailable(name) {
      pendingStatusFocus = name;
      const pane = panes.get(name);
      const status = pane && !pane.section.hidden
        ? (!pane.overlay.hidden ? pane.overlay : (!pane.loading.hidden ? pane.loading : null))
        : (!placeholder.hidden && placeholder.dataset.host === name && store.getHost(name)?.phase !== 'ready'
          ? placeholderOverlay
          : null);
      if (status) {
        pendingStatusFocus = null;
        status.focus();
      }
    },
    has: (name) => panes.has(name),
    openedHosts: () => [...panes.keys()],
    destroy() {
      for (const off of offs) off();
      for (const name of [...panes.keys()]) destroy(name);
    },
  };
}
