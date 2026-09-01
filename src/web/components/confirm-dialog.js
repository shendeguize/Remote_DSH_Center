/**
 * Promise 化的原生 <dialog> 确认框（10 §3.10 / UI-08）。
 * 串行处理：同一时刻只有一个确认在等，打开时聚焦「取消」，关闭后焦点归还触发元素。
 */

import { clear, el } from '../utils.js';

export function createConfirmDialog() {
  const title = el('h2', { id: 'confirm-title' });
  const body = el('div.confirm-body');
  const choiceBox = el('div.confirm-choices', { role: 'radiogroup', hidden: true });
  const cancelBtn = el('button.btn.btn-default', { type: 'button', value: 'cancel', text: '取消' });
  const secondaryBtn = el('button.btn.btn-default', { type: 'button', value: 'secondary', text: '次要操作', hidden: true });
  const okBtn = el('button.btn.btn-danger', { type: 'button', value: 'confirm', text: '确认' });

  const dialog = el('dialog.confirm-dialog', { 'aria-labelledby': 'confirm-title' }, [
    el('div.confirm-inner', {}, [
      title, body, choiceBox, el('footer.confirm-actions', {}, [cancelBtn, secondaryBtn, okBtn]),
    ]),
  ]);

  let settle = null;
  let restoreFocus = null;
  /** 本次确认要不要选一个对象；null = 是非题，确认即 true。 */
  let hasChoices = false;
  let selected = null;

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
  okBtn.addEventListener('click', () => finish(hasChoices ? selected : true));
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault(); // Escape 走同一条收口路径
    finish(false);
  });

  /**
   * 选项列表：确认不再只是「是/否」，而是「确认哪一个」。
   *
   * 单选而非下拉：候选要连同 PID、端口、命令行一起摆出来，用户才认得出该领养谁；
   * 不可用的候选（如端口未知）留在原位禁用并写明原因，而不是悄悄消失。
   * @param {{value:any, label:string, hint?:string, disabled?:boolean, reason?:string}[]} list
   */
  function renderChoices(list, label) {
    clear(choiceBox);
    hasChoices = list.length > 0;
    selected = null;
    choiceBox.hidden = !hasChoices;
    if (!hasChoices) return;
    choiceBox.setAttribute('aria-label', label ?? '可选项');
    const radios = [];
    for (const choice of list) {
      const disabled = choice.disabled === true;
      const radio = el('input.confirm-choice-input', {
        type: 'radio',
        name: 'confirm-choice',
        disabled,
        title: disabled ? (choice.reason ?? null) : null,
        'aria-label': choice.label,
        on: {
          change: () => {
            selected = choice.value;
            // 垫片没有 radio 组语义，真 DOM 里这步也无害（幂等）
            for (const other of radios) other.checked = other === radio;
            okBtn.disabled = false;
          },
        },
      });
      radios.push(radio);
      if (selected === null && !disabled) {
        radio.checked = true;
        selected = choice.value;
      }
      choiceBox.append(el('label.confirm-choice', {}, [
        radio,
        el('span', { text: choice.label }),
        choice.hint ? el('small', { text: choice.hint, title: choice.hint }) : null,
      ]));
    }
  }

  /**
   * @param {{title:string, lines?:string[], confirmLabel?:string, secondaryLabel?:string,
   *   danger?:boolean, choices?:object[], choicesLabel?:string}} opts
   * @returns {Promise<boolean|string|any>} 取消 false / 次要 'secondary' /
   *   确认 true（无选项）或所选项的 value
   */
  function confirm(opts) {
    if (settle) finish(false); // 串行：新的请求让旧的按取消收场
    title.textContent = opts.title;
    clear(body);
    for (const line of opts.lines ?? []) body.append(el('p', { text: line }));
    renderChoices(opts.choices ?? [], opts.choicesLabel);
    okBtn.disabled = hasChoices && selected === null;
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
