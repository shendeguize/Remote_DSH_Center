/**
 * 主机起始页：把日常入口压成可打开主机卡片，不可用主机只留一行摘要。
 *
 * 组件只消费 store 视图并调用既有 actions；ready 的「拉起 + 进入」仍由
 * actions.openHost 统一实现，这里不复制 phase 或请求推进逻辑。
 */

import {
  DASH, clear, el, phaseBadge, phaseMeta,
} from '../utils.js';
import { isHostEnabled, primaryHosts } from '../host-rules.js';
import {
  hostMappingSummary, hostPhaseMeta, hostStatusText,
} from '../host-presentation.js';

/** @param {Iterable<object>} hosts */
export function hubHosts(hosts) {
  const all = [...hosts];
  const primary = primaryHosts(all);
  const primarySet = new Set(primary);
  const byName = (a, b) => a.name.localeCompare(b.name);
  const unavailable = all.filter((host) => !primarySet.has(host)).sort(byName);
  return { primary, unavailable };
}

function mappingLine(host) {
  const mapping = hostMappingSummary(host);
  return mapping.line1 === DASH ? null : mapping.line1;
}

function cardSummary(host, store) {
  const mapping = mappingLine(host);
  if (store.hostBusy(host.name)) return '操作处理中…';
  switch (host.phase) {
    case 'ready':
      if (!store.canWrite()) return 'manager 已失联，暂时无法拉起';
      return mapping ? `${mapping} · 点击拉起并进入` : '点击拉起并进入';
    case 'starting':
      return host.local === true ? '正在拉起本机页面…' : '正在拉起并建立隧道…';
    case 'running':
      return mapping ? `${mapping} · 点击进入` : '页面已就绪 · 点击进入';
    case 'degraded':
      return mapping ? `${mapping} · 页面可打开，等待恢复` : '页面可打开，等待恢复';
    case 'crashed':
      return mapping ? `${mapping} · 保留上次页面` : '保留上次页面 · 点击查看';
    default:
      return phaseMeta(host.phase).label;
  }
}

function unavailableSummary(hosts) {
  const counts = new Map();
  for (const host of hosts) {
    const label = hostStatusText(host, { disabled: !isHostEnabled(host) });
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const detail = [...counts].map(([label, count]) => `${label} ${count}`).join(' · ');
  return `${hosts.length} 台主机不可用或已禁用${detail ? `（${detail}）` : ''}`;
}

export function createHub({ store, actions }) {
  const content = el('div.hub-content');
  const root = el('main.view.view-hub', { hidden: true }, [content]);

  function hostCard(host) {
    const active = store.state.route.kind === 'host' && store.state.route.host === host.name;
    return el('button.hub-host-card', {
      type: 'button',
      dataset: { host: host.name, phase: host.phase },
      class: active ? 'is-active' : '',
      'aria-label': `${host.name}，${hostPhaseMeta(host).label}，${cardSummary(host, store)}`,
      'aria-current': active ? 'page' : null,
      on: { click: () => actions.openHost(host.name) },
    }, [
      el('span.hub-host-head', {}, [
        el('strong', { text: host.name }),
        host.local === true ? el('span.tag.tag-lock', { text: '本机' }) : null,
      ]),
      phaseBadge(host.phase),
      el('span.hub-host-summary', { text: cardSummary(host, store) }),
    ]);
  }

  function render() {
    const hosts = store.listHosts();
    const { primary, unavailable } = hubHosts(hosts);
    const body = [];

    if (!store.state.hostsLoaded) {
      body.push(el('p.empty-hint.hub-syncing', { text: '正在同步主机…', role: 'status' }));
    } else if (hosts.length === 0) {
      body.push(el('section.hub-empty', {}, [
        el('p', { text: '还没有主机。可以先添加本机，或前往管理页配置远端主机。' }),
        el('div.hub-empty-actions', {}, [
          el('button.btn.btn-primary', {
            type: 'button',
            text: store.isPending('local:create') ? '正在添加本机…' : '添加本机',
            disabled: !store.canWrite() || store.isPending('local:create'),
            on: { click: () => actions.addLocalHost() },
          }),
          el('a.link', { href: '#/manage', text: '去管理' }),
        ]),
      ]));
    } else {
      if (primary.length > 0) {
        body.push(el('div.hub-host-grid', { 'aria-label': '可打开的主机' }, primary.map(hostCard)));
      } else {
        body.push(el('p.empty-hint', { text: '当前没有可打开的主机。' }));
      }
      if (unavailable.length > 0) {
        body.push(el('div.hub-unavailable', {}, [
          el('span', { text: unavailableSummary(unavailable) }),
          el('a.link', { href: '#/manage', text: '去管理' }),
        ]));
      }
    }

    clear(content).append(
      el('header.hub-hero', {}, [
        el('p.hub-brand', { text: '◆ DSH Center' }),
        el('h2', { text: '选择一台主机开始工作', tabindex: '-1' }),
      ]),
      ...body,
    );
  }

  const offs = [
    store.on('hosts:reset', render),
    store.on('hosts:changed', render),
    store.on('pending:changed', render),
    store.on('connection:changed', render),
    store.on('route:changed', render),
  ];
  render();

  return {
    root,
    render,
    destroy() {
      for (const off of offs) off();
    },
  };
}
