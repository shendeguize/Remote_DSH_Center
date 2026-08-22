/**
 * 应用外壳与启动装配（10 §3.1 / UI-01、UI-04、UI-06）。
 *
 * 首屏顺序：GET /api/manager/info 决定 setup 守卫 → 正常模式并行 GET /api/hosts
 * 与建 SSE；GET 结果不覆盖其请求发出后已收到的 SSE（10 §4.4）。
 */

import { api } from './api.js';
import { createActions } from './actions.js';
import { createStore } from './store.js';
import { bannerText, createSseClient } from './sse.js';
import {
  applyGuard, canOpenHost, parseRoute, rememberLastHost, rootRouteTarget,
} from './router.js';
import { button, clear, el, phaseMeta } from './utils.js';
import { createConfirmDialog } from './components/confirm-dialog.js';
import { createDefaultsCard } from './components/defaults-card.js';
import { createEventPanel } from './components/event-panel.js';
import { createHostDrawer } from './components/host-drawer.js';
import { createHostTable } from './components/host-table.js';
import { createHub } from './components/hub.js';
import { createIframePanes, hostTabId } from './components/iframe-pane.js';
import { createManagerCard } from './components/manager-card.js';
import { createSetupWizard } from './components/setup-wizard.js';
import { createTabbar, hostFallbackPanelId } from './components/tabbar.js';
import { createToastRegion } from './components/toast-region.js';

const CONNECTION_LABEL = Object.freeze({
  idle: 'manager 连接中',
  connecting: 'manager 连接中',
  open: 'manager 已连接',
  reconnecting: 'manager 重连中',
  offline: 'manager 离线',
});

export function bootApp({ root = document.getElementById('app') } = {}) {
  const store = createStore();
  const dialog = createConfirmDialog();
  const toasts = createToastRegion({ store });

  const actions = createActions({
    store,
    confirm: dialog.confirm,
    navigate: (to) => {
      // 向导旧动作把「完成」表达成回根路由；根路由现在会恢复 lastHost，
      // 但向导收尾必须稳定落在起始页。
      window.location.hash = to === '#/' && store.state.route.kind === 'setup' ? '#/hub' : to;
    },
  });

  const banner = el('div.disconnect-banner', { role: 'status', hidden: true });
  const header = el('header.app-header', {}, [
    el('div.brand', {}, [
      el('a.brand-link', { href: '#/hub', text: 'DSH Center' }),
      el('span.brand-sub', { text: '远端 dsh web 统一入口' }),
    ]),
  ]);

  const dashboard = el('main.view.view-dashboard', { hidden: true });
  const hub = createHub({ store, actions });
  const skeleton = el('main.view.view-skeleton', {}, [el('p.empty-hint', { text: '正在连接 manager…' })]);
  const fallback = el('main.view.view-fallback', {
    hidden: true,
    role: 'tabpanel',
    'aria-hidden': 'true',
  });

  // ── header 操作区 ────────────────────────────────────────────────────
  const probeAllBtn = button('全部探测', { variant: 'primary', compact: false, onClick: () => actions.probeAll() });
  const reloadBtn = button('重载配置', { compact: false, onClick: () => actions.reload() });
  probeAllBtn.classList.add('probe-all');
  reloadBtn.classList.add('reload-config');
  const connDot = el('span.conn-indicator', {
    role: 'status',
    'aria-live': 'polite',
    'aria-label': CONNECTION_LABEL.idle,
    title: CONNECTION_LABEL.idle,
  });

  // ── 管理台 ───────────────────────────────────────────────────────────
  const hostTable = createHostTable({ store, actions });
  const managerCard = createManagerCard({ store, actions });
  const defaultsCard = createDefaultsCard({ store, actions });
  const eventPanel = createEventPanel({ store });
  dashboard.append(
    el('div.card-header.manage-header', {}, [
      el('h2', { text: '管理' }),
      el('div.row-actions', {}, [probeAllBtn, reloadBtn]),
    ]),
    hostTable.root,
    el('div.side-by-side', {}, [managerCard.root, defaultsCard.root]),
    eventPanel.root,
  );

  // ── 标签栏 / iframe / 抽屉 ───────────────────────────────────────────
  const panes = createIframePanes({ store, actions });
  const tabbar = createTabbar({ store, actions, panes, trailing: connDot });
  const shell = el('div.app-shell', {}, [header, tabbar.root]);
  // 抽屉是「有遮罩即模态」（issue #28）：它开着时后景整片 inert，键盘就不会 Tab 到
  // 被遮罩压住的按钮上——那是鼠标碰不到、键盘却能碰到的两套规矩。层次归属放在
  // app 这层：只有它知道页面由哪几片组成，抽屉组件不该反过来伸手改兄弟节点。
  const backgroundLayers = [];
  const drawer = createHostDrawer({
    store,
    actions,
    confirm: dialog.confirm,
    setBackgroundInert: (on) => {
      for (const node of backgroundLayers) node.inert = on;
    },
  });

  // ── 首启向导 ─────────────────────────────────────────────────────────
  const wizard = createSetupWizard({ store, actions, confirm: dialog.confirm });

  // 抽屉开着时要 inert 的就是这一串（遮罩、抽屉本体、确认框、toast 不在其中——
  // 确认框正是抽屉自己弹的「放弃未保存的修改？」，inert 了就点不动）
  backgroundLayers.push(header, tabbar.root, banner, skeleton, hub.root, dashboard, panes.root, wizard.root, fallback);

  clear(root).append(
    shell,
    banner,
    skeleton,
    hub.root,
    dashboard,
    panes.root,
    wizard.root,
    fallback,
    drawer.scrim,
    drawer.root,
    tabbar.menu,
    tabbar.overflowMenu,
    toasts.root,
    dialog.root,
  );

  // ── 连接横幅 / 写操作禁用 ────────────────────────────────────────────
  const syncConnection = () => {
    const text = bannerText(store.state.connection, {
      managerRestarting: store.isPending('manager:restart'),
    });
    banner.hidden = text === null;
    banner.textContent = text ?? '';
    banner.dataset.tone = store.state.connection.sse === 'open' ? 'resync' : 'offline';
    const sseState = store.state.connection.sse;
    const connectionLabel = CONNECTION_LABEL[sseState] ?? CONNECTION_LABEL.connecting;
    connDot.dataset.state = sseState;
    connDot.setAttribute('aria-label', connectionLabel);
    connDot.setAttribute('title', connectionLabel);
    const writable = store.canWrite();
    probeAllBtn.disabled = !writable || store.isPending('probe-all');
    reloadBtn.disabled = !writable || store.isPending('config:reload');
  };
  store.on('connection:changed', syncConnection);
  store.on('pending:changed', syncConnection);
  syncConnection();

  // ── 路由 ─────────────────────────────────────────────────────────────
  let currentRoute = { kind: 'root', host: null, raw: '#/' };
  let wizardWasOpen = false; // 用来认出「刚从向导出来」这一跳

  function renderRoute() {
    const guarded = applyGuard(currentRoute, { setupCompleted: store.state.manager.setupCompleted });
    if (guarded.redirectTo && window.location.hash !== guarded.redirectTo) {
      window.location.replace(guarded.redirectTo);
      return;
    }

    const route = guarded.route;
    const rootWaiting = !guarded.blocked && route.kind === 'root' && !store.state.hostsLoaded;
    if (!guarded.blocked && route.kind === 'root' && !rootWaiting) {
      window.location.replace(rootRouteTarget(store.listHosts()));
      return;
    }

    const blocked = guarded.blocked || rootWaiting;
    store.setRoute(route);

    const wantHost = !blocked && route.kind === 'host';
    // 深链到不可开的主机：解析仍成立，但不造无效 iframe（10 §5.2）
    const host = wantHost ? store.getHost(route.host) : null;
    const openable = wantHost && canOpenHost(host);
    // ready 的启动请求已经发出、SSE 还没推进到 starting 时，也要让目标路由先落在
    // 页面占位区。这里只投影视图，不碰 host.phase；pending 一结算便重新按 SSE 真相判定。
    const startPending = wantHost && host?.phase === 'ready' && store.isPending('start', route.host);
    const showHostPane = openable || startPending;
    const showFallback = !blocked && wantHost && !showHostPane;
    if (openable) rememberLastHost(route.host);

    skeleton.hidden = !blocked;
    hub.root.hidden = blocked || route.kind !== 'hub';
    dashboard.hidden = blocked || route.kind !== 'manage';
    // fallback 与 iframe/启动占位使用不同 ID；切入正常 pane 前先摘掉 fallback 身份，
    // DOM 中任何时刻都不会有两个同名 panel。
    fallback.hidden = !showFallback;
    fallback.setAttribute('aria-hidden', String(!showFallback));
    if (showFallback) {
      fallback.setAttribute('id', hostFallbackPanelId(route.host));
      fallback.setAttribute('aria-labelledby', hostTabId(route.host));
    } else {
      fallback.removeAttribute('id');
      fallback.removeAttribute('aria-labelledby');
    }
    panes.show(showHostPane ? route.host : null);

    const showWizard = !blocked && route.kind === 'setup';
    const leavingWizard = wizardWasOpen && !showWizard;
    wizardWasOpen = showWizard;
    if (showWizard) wizard.open();
    else wizard.close();
    // 向导期间不显示管理台专属的写操作入口，避免误触未生效的配置
    shell.hidden = blocked || showWizard;
    header.hidden = shell.hidden;
    tabbar.root.hidden = shell.hidden;

    if (showFallback) {
      let msg;
      if (!host) msg = `主机 ${route.host} 不存在或尚未同步。`;
      else msg = `${route.host} 当前状态「${phaseMeta(host.phase).label}」，还没有可打开的页面。`;
      clear(fallback).append(
        el('p.empty-hint', { text: msg }),
        el('a.link', { href: '#/hub', text: '回到起始页' }),
      );
    }

    // 向导收尾：整块向导被藏起来，焦点跟着它一起没了（掉回 body），键盘用户刚走完
    // 四步、落到一个陌生页面还得从文档顶端重新 Tab。把焦点交给 hub 标题。
    if (leavingWizard && !hub.root.hidden) {
      const heading = hub.root.querySelector('h2');
      if (heading) {
        heading.focus();
      }
    }
  }

  const onHashChange = () => {
    currentRoute = parseRoute(window.location.hash);
    renderRoute();
  };
  window.addEventListener('hashchange', onHashChange);
  store.on('manager:changed', renderRoute);
  // 主机状态变化会影响「当前深链能否落地」：ready→running 时把 iframe 显出来
  store.on('hosts:changed', (name) => {
    if (store.state.route.kind === 'host' && store.state.route.host === name) renderRoute();
  });
  store.on('hosts:reset', () => {
    if (store.state.route.kind === 'host' || store.state.route.kind === 'root') renderRoute();
  });
  // ready + start pending 是 host 路由的短暂视图态：开始时显示占位，失败/超时结算后
  // 若 SSE 仍是 ready，就立刻回到准确 fallback。
  store.on('pending:changed', () => {
    if (store.state.route.kind === 'host') renderRoute();
  });

  // ── SSE ──────────────────────────────────────────────────────────────
  const sse = createSseClient({ store });
  const detachLifecycle = sse.attachLifecycle();

  // ── 首屏 ─────────────────────────────────────────────────────────────
  async function boot() {
    currentRoute = parseRoute(window.location.hash);
    renderRoute();
    try {
      const info = await api.managerInfo();
      store.setManagerInfo(info);
    } catch (err) {
      actions.reportError(err, '无法获取 manager 信息');
      clear(skeleton).append(
        el('p.empty-hint', { text: '无法连接 manager。确认它已启动（dshc up）后重试。' }),
        button('重试', { variant: 'primary', compact: false, onClick: () => boot() }),
      );
      return;
    }
    renderRoute();

    // setup 模式（13 §4 白名单）：SSE 与 GET /api/config 可用——向导要靠 SSE 收
    // 逐台探测结果、靠 config 预填现值；主机清单等向导走到第 3 步再拉。
    sse.connect();
    if (store.state.manager.setupCompleted === false) {
      try {
        store.setDefaults((await api.config()).defaults);
      } catch (err) {
        actions.reportError(err, '读取当前配置失败（向导将使用出厂默认）');
      }
      renderRoute();
      return;
    }

    const startedAt = performance.now(); // 单调钟：与 __receivedAt 比先后，墙钟会跳（#104）
    try {
      const [hosts, config] = await Promise.all([api.hosts(), api.config()]);
      store.mergeFetchedHosts(hosts.hosts, hosts.revision, startedAt);
      store.setDefaults(config.defaults);
    } catch (err) {
      // SSE 的 snapshot 是主路径，GET 只是兜底：失败降级为提示
      actions.reportError(err, '主机列表首屏加载失败（等待实时同步）');
    }
  }

  boot();

  return {
    store,
    actions,
    sse,
    destroy() {
      window.removeEventListener('hashchange', onHashChange);
      detachLifecycle();
      sse.close();
      for (const c of [hub, hostTable, managerCard, defaultsCard, eventPanel, tabbar, panes, drawer, wizard, toasts]) c.destroy();
    },
  };
}
