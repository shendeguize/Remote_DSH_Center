/**
 * 全局 toast（10 §3.9 / UI-07）。成功 5s 自动关闭，错误留到手动关闭；
 * stderr 一律 textContent 渲染。
 */

import { clear, copyText, el } from '../utils.js';

const AUTO_DISMISS_MS = { info: 5_000, success: 5_000, warn: 8_000, error: null };

export function createToastRegion({ store }) {
  const root = el('div.toast-region', { 'aria-live': 'polite', role: 'status' });
  const timers = new Map();

  const render = () => {
    clear(root);
    for (const toast of store.state.toasts) {
      root.append(renderToast(toast));
      scheduleDismiss(toast);
    }
  };

  function scheduleDismiss(toast) {
    if (timers.has(toast.id)) return;
    const ms = toast.timeoutMs ?? AUTO_DISMISS_MS[toast.level] ?? 5_000;
    if (ms === null) return;
    timers.set(toast.id, setTimeout(() => {
      timers.delete(toast.id);
      store.dismissToast(toast.id);
    }, ms));
  }

  function renderToast(toast) {
    const node = el(`article.toast.toast-${toast.level}`, {}, [
      el('p.summary', { text: toast.count > 1 ? `${toast.summary}（×${toast.count}）` : toast.summary }),
    ]);
    if (toast.detail) {
      const pre = el('pre.detail', { text: toast.detail });
      node.append(el('details', {}, [el('summary', { text: '详情' }), pre, el('div.detail-actions', {}, [
        el('button.btn.btn-compact.btn-default', {
          type: 'button', text: '复制', on: { click: () => copyText(toast.detail) },
        }),
      ])]));
    }
    node.append(el('button.toast-close', {
      type: 'button',
      'aria-label': '关闭',
      text: '×',
      on: {
        click: () => {
          const timer = timers.get(toast.id);
          if (timer) clearTimeout(timer);
          timers.delete(toast.id);
          store.dismissToast(toast.id);
        },
      },
    }));
    return node;
  }

  const off = store.on('toasts:changed', render);
  render();

  return {
    root,
    destroy() {
      off();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
