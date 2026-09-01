/**
 * Promise 化的原生 <dialog> 确认框（10 §3.10 / UI-08）。
 * 串行处理：同一时刻只有一个确认在等，打开时聚焦「取消」，关闭后焦点归还触发元素。
 */

import { clear, el } from '../utils.js';

export function createConfirmDialog() {
  const title = el('h2', { id: 'confirm-title' });
  const body = el('div.confirm-body');
  const cancelBtn = el('button.btn.btn-default', { type: 'button', value: 'cancel', text: '取消' });
  const secondaryBtn = el('button.btn.btn-default', { type: 'button', value: 'secondary', text: '次要操作', hidden: true });
  const okBtn = el('button.btn.btn-danger', { type: 'button', value: 'confirm', text: '确认' });

  const dialog = el('dialog.confirm-dialog', { 'aria-labelledby': 'confirm-title' }, [
    el('div.confirm-inner', {}, [title, body, el('footer.confirm-actions', {}, [cancelBtn, secondaryBtn, okBtn])]),
  ]);

  let settle = null;
  let restoreFocus = null;

  const finish = (value) => {
    if (!settle) return;
    const done = settle;
    settle = null;
    if (dialog.open) dialog.close();
    done(value);
    restoreFocus?.focus?.();
    restoreFocus = null;
  };

  cancelBtn.addEventListener('click', () => finish(false));
  secondaryBtn.addEventListener('click', () => finish('secondary'));
  okBtn.addEventListener('click', () => finish(true));
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault(); // Escape 走同一条收口路径
    finish(false);
  });

  /**
   * @param {{title:string, lines?:string[], confirmLabel?:string, secondaryLabel?:string, danger?:boolean}} opts
   * @returns {Promise<boolean|string>}
   */
  function confirm(opts) {
    if (settle) finish(false); // 串行：新的请求让旧的按取消收场
    title.textContent = opts.title;
    clear(body);
    for (const line of opts.lines ?? []) body.append(el('p', { text: line }));
    okBtn.textContent = opts.confirmLabel ?? '确认';
    secondaryBtn.hidden = !opts.secondaryLabel;
    secondaryBtn.textContent = opts.secondaryLabel ?? '次要操作';
    okBtn.className = `btn ${opts.danger === false ? 'btn-primary' : 'btn-danger'}`;
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    return new Promise((resolve) => {
      settle = resolve;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      cancelBtn.focus();
    });
  }
  confirm.cancel = () => finish(false);

  return { root: dialog, confirm };
}
