/**
 * 全局默认卡（10 §3.7 / UI-17）。manager.port 改动只落盘；重启提示始终由
 * configuredPort 与实际监听端口的差异派生（13 §2.6）。
 */

import { button, el } from '../utils.js';
import {
  buildDefaultsPatch,
  deepEqual,
  diffPatch,
  field,
  input,
} from '../form.js';
import { BINDABLE_PORT_MIN, PORT_MAX, PORT_MIN } from '../setup-schema.js';

export function createDefaultsCard({ store, actions }) {
  const remote = field('远端默认 web 端口', input('number', '', { min: PORT_MIN, max: PORT_MAX }));
  const rangeFrom = field('本机端口区间起点', input('number', '', { min: BINDABLE_PORT_MIN, max: PORT_MAX }));
  const rangeTo = field('本机端口区间终点', input('number', '', { min: BINDABLE_PORT_MIN, max: PORT_MAX }));
  const managerPort = field('manager 监听端口', input('number', '', { min: PORT_MIN, max: PORT_MAX }), {
    hint: '改动仅落盘，需重启 manager 生效',
  });
  const hostFilterDeny = field(
    '主机黑名单（每行一条正则）',
    input('textarea', '', { rows: '4', spellcheck: 'false', autocapitalize: 'off' }),
    { hint: '整串匹配、不分大小写。命中的 ssh config 条目不纳管，如 git\\..*' },
  );
  const hostFilterAllow = field(
    '主机白名单（每行一条正则，留空=全放行）',
    input('textarea', '', { rows: '3', spellcheck: 'false', autocapitalize: 'off' }),
    { hint: '一旦非空就只纳管命中的；黑名单优先' },
  );

  const saveBtn = button('保存', { variant: 'primary', compact: false, onClick: submit });
  const resetBtn = button('还原', { compact: false, onClick: resetDraft });
  const notice = el('p.card-notice', { hidden: true });

  const root = el('article.card.defaults-card', {}, [
    el('header.card-header', {}, [el('h2', { text: '全局默认' })]),
    el('div.field-grid', {}, [remote.root, managerPort.root, rangeFrom.root, rangeTo.root]),
    el('div.field-grid.field-grid-wide', {}, [hostFilterDeny.root, hostFilterAllow.root]),
    notice,
    el('footer.card-footer', {}, [saveBtn, resetBtn]),
  ]);

  const controls = {
    remoteWebPort: remote,
    managerPort,
    rangeFrom,
    rangeTo,
    hostFilterDeny,
    hostFilterAllow,
  };
  const draftKeys = Object.keys(controls);
  let baseline = configFromStore();
  const conflicts = new Set();

  function configFromStore() {
    const defaults = store.state.defaults;
    const info = store.state.manager.info;
    const configuredPort = store.state.manager.configuredPort ?? info?.port ?? null;
    return {
      remoteWebPort: defaults?.remoteWebPort ?? null,
      localPortRange: Array.isArray(defaults?.localPortRange) ? [...defaults.localPortRange] : null,
      hostFilter: {
        allow: [...(defaults?.hostFilter?.allow ?? [])],
        deny: [...(defaults?.hostFilter?.deny ?? [])],
      },
      manager: { port: configuredPort },
    };
  }

  function draftOf(config) {
    return {
      remoteWebPort: config?.remoteWebPort == null ? '' : String(config.remoteWebPort),
      managerPort: config?.manager?.port == null ? '' : String(config.manager.port),
      rangeFrom: config?.localPortRange?.[0] == null ? '' : String(config.localPortRange[0]),
      rangeTo: config?.localPortRange?.[1] == null ? '' : String(config.localPortRange[1]),
      hostFilterDeny: (config?.hostFilter?.deny ?? []).join('\n'),
      hostFilterAllow: (config?.hostFilter?.allow ?? []).join('\n'),
    };
  }

  function readDraft() {
    return Object.fromEntries(draftKeys.map((key) => [key, controls[key].input.value]));
  }

  function writeDraft(draft, keys = draftKeys) {
    for (const key of keys) controls[key].input.value = draft[key];
  }

  function clearErrors(keys = draftKeys) {
    for (const key of keys) controls[key].setError(null);
  }

  function renderNotice() {
    const messages = [];
    if (conflicts.size > 0) {
      messages.push('服务端配置已变化；同字段的本地草稿已保留。「还原」可载入最新服务端值。');
    }
    const runtimePort = store.state.manager.info?.port ?? null;
    const configuredPort = store.state.manager.configuredPort;
    if (configuredPort != null && runtimePort != null && configuredPort !== runtimePort) {
      messages.push(`manager 端口已配置为 ${configuredPort}，重启 manager 后生效。`);
    }
    notice.textContent = messages.join('\n');
    notice.hidden = messages.length === 0;
  }

  function isDirty() {
    return !deepEqual(readDraft(), draftOf(baseline));
  }

  function syncDisabled() {
    const pending = store.isPending('defaults:save');
    const dirty = isDirty();
    saveBtn.disabled = !dirty || !store.canWrite() || pending;
    resetBtn.disabled = !dirty || pending;
    for (const f of Object.values(controls)) f.input.disabled = pending;
  }

  function syncDraftState() {
    const draft = readDraft();
    const canonical = draftOf(baseline);
    for (const key of conflicts) {
      if (draft[key] === canonical[key]) conflicts.delete(key);
    }
    renderNotice();
    syncDisabled();
  }

  function resetDraft() {
    if (store.isPending('defaults:save')) return;
    baseline = configFromStore();
    writeDraft(draftOf(baseline));
    clearErrors();
    conflicts.clear();
    syncDraftState();
  }

  /**
   * 服务端更新按字段三方合并：用户没动的字段跟随；双方都动了同一字段时，
   * baseline 仍推进到最新服务端值，但保留 DOM 草稿并提示冲突。
   */
  function reconcileFromStore() {
    const next = configFromStore();
    const previousDraft = draftOf(baseline);
    const nextDraft = draftOf(next);
    const draft = readDraft();
    for (const key of draftKeys) {
      const localChanged = draft[key] !== previousDraft[key];
      const serverChanged = nextDraft[key] !== previousDraft[key];
      if (!localChanged) {
        controls[key].input.value = nextDraft[key];
        controls[key].setError(null);
        conflicts.delete(key);
      } else if (serverChanged) {
        if (draft[key] === nextDraft[key]) {
          controls[key].input.value = nextDraft[key];
          controls[key].setError(null);
          conflicts.delete(key);
        } else {
          conflicts.add(key);
        }
      }
    }
    baseline = next;
    syncDraftState();
  }

  function onDraftChanged(event) {
    const key = draftKeys.find((candidate) => controls[candidate].input === event.target);
    if (key) {
      if (key === 'rangeFrom' || key === 'rangeTo') rangeFrom.setError(null);
      else controls[key].setError(null);
    }
    syncDraftState();
  }

  async function submit() {
    if (store.isPending('defaults:save') || !store.canWrite()) return;
    const built = buildDefaultsPatch({
      remoteWebPort: remote.input.value,
      rangeFrom: rangeFrom.input.value,
      rangeTo: rangeTo.input.value,
      managerPort: managerPort.input.value,
      hostFilterDeny: hostFilterDeny.input.value,
      hostFilterAllow: hostFilterAllow.input.value,
    }, { minWidth: Math.max(1, store.state.hosts.size) });

    remote.setError(built.errors?.remoteWebPort ?? null);
    rangeFrom.setError(built.errors?.localPortRange ?? null);
    rangeTo.setError(null);
    managerPort.setError(built.errors?.managerPort ?? null);
    hostFilterDeny.setError(built.errors?.hostFilterDeny ?? null);
    hostFilterAllow.setError(built.errors?.hostFilterAllow ?? null);
    if (!built.ok) return;

    const patch = diffPatch(built.value, baseline);
    if (Object.keys(patch).length === 0) {
      writeDraft(draftOf(baseline));
      clearErrors();
      conflicts.clear();
      syncDraftState();
      store.addToast({ level: 'info', summary: '没有需要保存的有效变更' });
      return;
    }

    const res = await actions.saveDefaults(patch);
    if (!res) return;
    baseline = configFromStore();
    writeDraft(draftOf(baseline));
    clearErrors();
    conflicts.clear();
    syncDraftState();
  }

  for (const f of Object.values(controls)) {
    f.input.addEventListener('input', onDraftChanged);
    f.input.addEventListener('change', onDraftChanged);
  }

  const offs = [
    store.on('defaults:changed', reconcileFromStore),
    store.on('manager:changed', reconcileFromStore),
    store.on('manager-config:changed', reconcileFromStore),
    store.on('pending:changed', syncDraftState),
    store.on('connection:changed', syncDraftState),
    store.on('hosts:reset', syncDraftState),
  ];
  resetDraft();

  return {
    root,
    destroy() {
      for (const off of offs) off();
    },
  };
}
