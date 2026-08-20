/**
 * 全局默认卡（10 §3.7 / UI-17）。manager.port 改动只落盘，
 * 由响应的 restartRequired 决定是否提示重启（13 §2.6）。
 */

import { button, el } from '../utils.js';
import { buildDefaultsPatch, field, input } from '../form.js';

export function createDefaultsCard({ store, actions }) {
  const remote = field('远端默认 web 端口', input('number', '', { min: '1', max: '65535' }));
  const rangeFrom = field('本机端口区间起点', input('number', '', { min: '1', max: '65535' }));
  const rangeTo = field('本机端口区间终点', input('number', '', { min: '1', max: '65535' }));
  const managerPort = field('manager 监听端口', input('number', '', { min: '1', max: '65535' }), {
    hint: '改动仅落盘，需重启 manager 生效',
  });

  const saveBtn = button('保存', { variant: 'primary', compact: false, onClick: submit });
  const resetBtn = button('还原', { compact: false, onClick: () => fill() });
  const notice = el('p.card-notice', { hidden: true });

  const root = el('article.card.defaults-card', {}, [
    el('header.card-header', {}, [el('h2', { text: '全局默认' })]),
    el('div.field-grid', {}, [remote.root, managerPort.root, rangeFrom.root, rangeTo.root]),
    notice,
    el('footer.card-footer', {}, [saveBtn, resetBtn]),
  ]);

  function fill() {
    const defaults = store.state.defaults;
    const info = store.state.manager.info;
    remote.input.value = defaults?.remoteWebPort ?? '';
    rangeFrom.input.value = defaults?.localPortRange?.[0] ?? '';
    rangeTo.input.value = defaults?.localPortRange?.[1] ?? '';
    managerPort.input.value = info?.port ?? '';
    for (const f of [remote, rangeFrom, rangeTo, managerPort]) f.setError(null);
    notice.hidden = true;
    syncDisabled();
  }

  function syncDisabled() {
    const busy = store.isPending('defaults:save') || !store.canWrite();
    saveBtn.disabled = busy;
    resetBtn.disabled = busy;
    for (const f of [remote, rangeFrom, rangeTo, managerPort]) f.input.disabled = busy;
  }

  async function submit() {
    const built = buildDefaultsPatch({
      remoteWebPort: remote.input.value,
      rangeFrom: rangeFrom.input.value,
      rangeTo: rangeTo.input.value,
      managerPort: managerPort.input.value,
    }, { minWidth: Math.max(1, store.state.hosts.size) });

    remote.setError(built.errors?.remoteWebPort ?? null);
    rangeFrom.setError(built.errors?.localPortRange ?? null);
    rangeTo.setError(null);
    managerPort.setError(built.errors?.managerPort ?? null);
    if (!built.ok) return;

    const res = await actions.saveDefaults(built.value);
    if (!res) return;
    notice.hidden = !res.restartRequired;
    notice.textContent = res.restartRequired
      ? `manager 端口已改为 ${res.manager?.port}，重启 manager 后生效。`
      : '';
  }

  const offs = [
    store.on('defaults:changed', fill),
    store.on('manager:changed', syncDisabled),
    store.on('pending:changed', syncDisabled),
    store.on('connection:changed', syncDisabled),
    store.on('hosts:reset', syncDisabled),
  ];
  fill();

  return {
    root,
    destroy() {
      for (const off of offs) off();
    },
  };
}
