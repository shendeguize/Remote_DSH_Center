/**
 * 全局 toast（10 §3.9 / UI-07）。成功 5s 自动关闭，错误留到手动关闭；
 * stderr 一律 textContent 渲染。
 */

import { copyText, el } from '../utils.js';

/** `null` = 这一档不自动关闭（错误留到手动关）。缺档才落到 FALLBACK_MS。 */
const AUTO_DISMISS_MS = { info: 5_000, success: 5_000, warn: 8_000, error: null };
const FALLBACK_MS = 5_000;

export function createToastRegion({ store }) {
  const root = el('div.toast-region', { 'aria-live': 'polite', role: 'status' });
  const timers = new Map();
  const savedTabindex = new WeakMap();
  /** toast.id → 已经渲染好的节点，跨次渲染复用。 */
  const rendered = new Map();
  let modalBlocked = false;

  /**
   * 按 id 复用节点，不整片重建。错误 toast 里的「详情」常是排障唯一的线索，人正读着
   * 的时候又弹出一条（批量操作一次弹好几条很常见），整片重建会把 `<details>` 的展开
   * 状态清零、焦点甩回 body（issue #114）。
   */
  const render = () => {
    const live = new Set();
    for (const toast of store.state.toasts) {
      live.add(toast.id);
      let entry = rendered.get(toast.id);
      if (entry === undefined) {
        entry = renderToast(toast);
        rendered.set(toast.id, entry);
      }
      entry.summary.textContent = summaryText(toast); // 会变的只有重复计数
      scheduleDismiss(toast);
    }

    for (const [id, entry] of rendered) {
      if (live.has(id)) continue;
      entry.node.remove();
      rendered.delete(id);
    }

    // 对齐顺序。toast 只在尾部追加、从头部淘汰，幸存者的相对次序不会变，实际只有新
    // 节点会被插进来；但仍逐个核对，免得将来换了插入策略这里悄悄错位。只在真的不对
    // 位时才动——挪一个已经在树上的节点等于摘下来再插回去，焦点会掉。
    let cursor = root.firstChild;
    for (const toast of store.state.toasts) {
      const { node } = rendered.get(toast.id);
      if (node === cursor) {
        cursor = cursor.nextSibling;
        continue;
      }
      root.insertBefore(node, cursor);
    }

    syncModalBlocked();
  };

  /**
   * toast 留在 aria-live 树里播报抽屉内的保存错误。模态期间只把控件移出
   * 外部 Tab 环，不阻断 pointer/click，保证用户仍能关闭或复制通知。
   */
  function syncModalBlocked() {
    const controls = [
      ...root.querySelectorAll('summary'),
      ...root.querySelectorAll('button'),
    ];
    for (const control of controls) {
      if (modalBlocked) {
        if (!savedTabindex.has(control)) savedTabindex.set(control, control.getAttribute('tabindex'));
        control.setAttribute('tabindex', '-1');
        continue;
      }
      if (!savedTabindex.has(control)) continue;
      const previous = savedTabindex.get(control);
      if (previous === null) control.removeAttribute('tabindex');
      else control.setAttribute('tabindex', previous);
      savedTabindex.delete(control);
    }
  }

  function setModalBlocked(on) {
    modalBlocked = Boolean(on);
    syncModalBlocked();
  }

  /**
   * `??` 分不清「没配这一档」和「明确配成不关」：`null ?? 5_000` 会把「不关」变回 5 秒，
   * 让 `error: null` 形同虚设（issue #114）。所以逐级判断，让 null 真的传得下去。
   * 注意 store 的 addToast 默认就给 `timeoutMs: null`，那是「这条没单独指定」的意思，
   * 与档位表里的 null 含义不同——这里用 `!= null` 把它当未指定处理。
   */
  function dismissDelay(toast) {
    if (toast.timeoutMs != null) return toast.timeoutMs;
    if (Object.hasOwn(AUTO_DISMISS_MS, toast.level)) return AUTO_DISMISS_MS[toast.level];
    return FALLBACK_MS;
  }

  function scheduleDismiss(toast) {
    if (timers.has(toast.id)) return;
    const ms = dismissDelay(toast);
    if (ms === null) return;
    timers.set(toast.id, setTimeout(() => {
      timers.delete(toast.id);
      store.dismissToast(toast.id);
    }, ms));
  }

  function summaryText(toast) {
    return toast.count > 1 ? `${toast.summary}（×${toast.count}）` : toast.summary;
  }

  function renderToast(toast) {
    const summary = el('p.summary', { text: summaryText(toast) });
    const node = el(`article.toast.toast-${toast.level}`, {}, [summary]);
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
    return { node, summary };
  }

  const off = store.on('toasts:changed', render);
  render();

  return {
    root,
    setModalBlocked,
    destroy() {
      off();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
