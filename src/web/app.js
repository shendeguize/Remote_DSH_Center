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
import { applyGuard, canOpenHost, parseRoute } from './router.js';
import { button, clear, el, phaseMeta } from './utils.js';
import { createConfirmDialog } from './components/confirm-dialog.js';
import { createDefaultsCard } from './components/defaults-card.js';
import { createEventPanel } from './components/event-panel.js';
import { createHostDrawer } from './components/host-drawer.js';
import { createHostTable } from './components/host-table.js';
import { createIframePanes } from './components/iframe-pane.js';
import { createManagerCard } from './components/manager-card.js';
import { createSetupWizard } from './components/setup-wizard.js';
import { createTabbar } from './components/tabbar.js';
import { createToastRegion } from './components/toast-region.js';

export function bootApp({ root = document.getElementById('app') } = {}) {
  const store = createStore();
  const dialog = createConfirmDialog();
  const toasts = createToastRegion({ store });

  const actions = createActions({
    store,
    confirm: dialog.confirm,
    navigate: (to) => {
      window.location.hash = to;
    },
  });

  const banner = el('div.disconnect-banner', { role: 'status', hidden: true });
  const headerRight = el('div.header-actions');
  const header = el('header.app-header', {}, [
    el('div.brand', {}, [
      el('a.brand-link', { href: '#/', text: 'DSH Center' }),
      el('span.brand-sub', { text: '远端 dsh web 统一入口' }),
    ]),
    headerRight,
  ]);

  const dashboard = el('main.view.view-dashboard', { hidden: true });
  const skeleton = el('main.view.view-skeleton', {}, [el('p.empty-hint', { text: '正在连接 manager…' })]);
  const fallback = el('main.view.view-fallback', { hidden: true });

  // ── header 操作区 ────────────────────────────────────────────────────
  const probeAllBtn = button('全部探测', { variant: 'primary', compact: false, onClick: () => actions.probeAll() });
  const reloadBtn = button('重载配置', { compact: false, onClick: () => actions.reload() });
  const connDot = el('span.conn-indicator', { title: '与 manager 的实时连接' });
  headerRight.append(probeAllBtn, reloadBtn, connDot);

  // ── 管理台 ───────────────────────────────────────────────────────────
  const hostTable = createHostTable({ store, actions });
  const managerCard = createManagerCard({ store, actions });
  const defaultsCard = createDefaultsCard({ store, actions });
  const eventPanel = createEventPanel({ store });
  dashboard.append(
    hostTable.root,
    el('div.side-by-side', {}, [managerCard.root, defaultsCard.root]),
    eventPanel.root,
  );

  // ── 标签栏 / iframe / 抽屉 ───────────────────────────────────────────
  const panes = createIframePanes({ store, actions });
  const tabbar = createTabbar({ store, actions, panes });
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
  backgroundLayers.push(header, tabbar.root, banner, skeleton, dashboard, panes.root, wizard.root, fallback);

  clear(root).append(
    header,
    tabbar.root,
    banner,
    skeleton,
    dashboard,
    panes.root,
    wizard.root,
    fallback,
    drawer.scrim,
    drawer.root,
    tabbar.menu,
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
    connDot.dataset.state = store.state.connection.sse;
    const writable = store.canWrite();
    probeAllBtn.disabled = !writable || store.isPending('probe-all');
    reloadBtn.disabled = !writable || store.isPending('config:reload');
  };
  store.on('connection:changed', syncConnection);
  store.on('pending:changed', syncConnection);
  syncConnection();

  // ── 路由 ─────────────────────────────────────────────────────────────
  let currentRoute = { kind: 'dashboard', host: null, raw: '#/' };

  function renderRoute() {
    const guarded = applyGuard(currentRoute, { setupCompleted: store.state.manager.setupCompleted });
    if (guarded.redirectTo && window.location.hash !== guarded.redirectTo) {
      window.location.replace(guarded.redirectTo);
      return;
    }
    store.setRoute(guarded.route);

    const route = guarded.route;
    const wantHost = !guarded.blocked && route.kind === 'host';
    // 深链到不可开的主机：解析仍成立，但不造无效 iframe（10 §5.2）
    const host = wantHost ? store.getHost(route.host) : null;
    const openable = wantHost && canOpenHost(host);

    skeleton.hidden = !guarded.blocked;
    dashboard.hidden = guarded.blocked || route.kind !== 'dashboard';
    tabbar.root.hidden = guarded.blocked || route.kind === 'setup';
    panes.show(openable ? route.host : null);

    const showWizard = !guarded.blocked && route.kind === 'setup';
    if (showWizard) wizard.open();
    else wizard.close();
    // 向导期间不显示管理台专属的写操作入口，避免误触未生效的配置
    header.hidden = showWizard;

    const showFallback = !guarded.blocked && wantHost && !openable;
    fallback.hidden = !showFallback;
    if (showFallback) {
      let msg;
      if (!host) msg = `主机 ${route.host} 不存在或尚未同步。`;
      else msg = `${route.host} 当前状态「${phaseMeta(host.phase).label}」，还没有可打开的页面。`;
      clear(fallback).append(
        el('p.empty-hint', { text: msg }),
        el('a.link', { href: '#/', text: '返回管理台' }),
      );
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
    if (store.state.route.kind === 'host') renderRoute();
  });

  // ── SSE ──────────────────────────────────────────────────────────────
  const sse = createSseClient({ store });
  const detachLifecycle = sse.attachLifecycle();

  // ── 首屏 ─────────────────────────────────────────────────────────────
  async function boot() {
    currentRoute = parseRoute(window.location.hash);
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

    const startedAt = Date.now();
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
      for (const c of [hostTable, managerCard, defaultsCard, eventPanel, tabbar, panes, drawer, wizard, toasts]) c.destroy();
    },
  };
}
