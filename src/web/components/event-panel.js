/**
 * 事件面板（10 §3.8 / UI-18）。环形缓冲 50 条由 store 保证；
 * 面板只做渲染 + 主机过滤 + 折叠。
 */

import { clear, el, fmtClock } from '../utils.js';

const LEVEL_LABEL = { info: '信息', warn: '警告', error: '错误' };

export function createEventPanel({ store }) {
  const list = el('ul.event-list', { 'aria-live': 'polite' });
  const filter = el('select.event-filter', {
    'aria-label': '按主机过滤事件',
    on: { change: () => render() },
  });
  const clearBtn = el('button.btn.btn-compact.btn-default', {
    type: 'button', text: '清空', on: { click: () => store.clearEvents() },
  });
  const body = el('div.event-body', {}, [
    el('div.event-toolbar', {}, [filter, clearBtn]),
    list,
  ]);

  const root = el('section.card.event-panel', {}, [
    el('header.card-header', {}, [
      el('h2', { text: '事件' }),
      el('button.btn.btn-compact.btn-default.collapse-toggle', {
        type: 'button',
        text: '折叠',
        'aria-expanded': 'true',
        on: {
          click: (e) => {
            const open = body.hidden;
            body.hidden = !open;
            e.target.textContent = open ? '折叠' : '展开';
            e.target.setAttribute('aria-expanded', String(open));
          },
        },
      }),
    ]),
    body,
  ]);

  function renderFilter() {
    const selected = filter.value;
    clear(filter);
    filter.append(el('option', { value: '', text: '全部主机' }));
    for (const name of [...store.state.hosts.keys()].sort()) {
      filter.append(el('option', { value: name, text: name }));
    }
    filter.value = [...filter.options].some((o) => o.value === selected) ? selected : '';
  }

  function render() {
    const want = filter.value;
    clear(list);
    const events = store.state.events.filter((e) => want === '' || e.host === want);
    if (events.length === 0) {
      list.append(el('li.empty-hint', { text: '暂无事件' }));
      return;
    }
    for (const ev of events.slice().reverse()) {
      list.append(el(`li.event-item.event-${ev.level}`, {}, [
        el('time', { datetime: ev.ts, text: fmtClock(ev.ts), title: ev.ts }),
        el('span.event-level', { text: LEVEL_LABEL[ev.level] ?? ev.level }),
        el('span.event-host', { text: ev.host ?? 'manager' }),
        el('span.event-msg', { text: ev.msg, title: ev.detail ?? ev.msg }),
      ]));
    }
  }

  const offs = [
    store.on('events:changed', render),
    store.on('hosts:reset', () => {
      renderFilter();
      render();
    }),
  ];
  renderFilter();
  render();

  return {
    root,
    destroy() {
      for (const off of offs) off();
    },
  };
}
