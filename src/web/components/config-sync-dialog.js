/**
 * 批量配置同步：选择源/目标 → dry-run 预览 → 服务端重新计算并原子应用。
 *
 * UI 只消费 changedFields，绝不读取或展示配置值（尤其是环境变量与 secret）。
 */

import { CONFIG_SYNC_TARGET_LIMIT } from '../actions.js';
import { button, clear, el } from '../utils.js';

const FIELD_LABEL = Object.freeze({
  remoteWebPort: '远端 web 端口',
  workdir: '工作目录',
  'inject.env': '环境变量',
  'inject.extraArgs': '附加参数',
  'inject.patches': '补丁',
});

const RESTART_PHASES = new Set(['running', 'degraded', 'starting']);

export function createConfigSyncDialog({ store, actions }) {
  const sourceSelect = el('select.config-sync-source', { id: 'config-sync-source' });
  const targetList = el('div.config-sync-targets');
  const status = el('p.config-sync-status', {
    id: 'config-sync-status',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
  });
  const targetCount = el('p.config-sync-target-count', {
    id: 'config-sync-target-count',
  });
  const errorSlot = el('div.config-sync-error', {
    id: 'config-sync-error',
    role: 'alert',
    'aria-live': 'assertive',
    'aria-atomic': 'true',
    hidden: true,
  });
  const resultSlot = el('div.config-sync-result-slot');

  const selectAllBtn = button('全选', { onClick: selectAll });
  const clearBtn = button('清空', { onClick: clearTargets });
  selectAllBtn.classList.add('config-sync-select-all');
  clearBtn.classList.add('config-sync-clear');

  const closeBtn = button('取消', { compact: false, onClick: close });
  const previewBtn = button('预览变更', { compact: false, onClick: preview });
  const applyBtn = button('应用同步', { variant: 'primary', compact: false, onClick: apply });
  closeBtn.classList.add('config-sync-close');
  previewBtn.classList.add('config-sync-preview');
  applyBtn.classList.add('config-sync-apply');

  const safety = el('p.config-sync-safety', {
    id: 'config-sync-safety',
    text: '只同步远端 web 端口、工作目录、环境变量、附加参数、补丁；不会修改主机身份、启用/自启或本机映射端口。',
  });
  const dialog = el('dialog.config-sync-dialog', {
    'aria-labelledby': 'config-sync-title',
    'aria-describedby': 'config-sync-safety config-sync-target-count config-sync-status config-sync-error',
  }, [
    el('div.config-sync-inner', {}, [
      el('header.config-sync-head', {}, [
        el('h2', { id: 'config-sync-title', text: '批量同步配置' }),
        el('p', { text: '先预览差异，再把一台主机的启动配置同步到多台目标主机。' }),
      ]),
      el('div.config-sync-body', {}, [
        safety,
        el('div.field', {}, [
          el('label', { for: 'config-sync-source', text: '源主机' }),
          sourceSelect,
        ]),
        el('fieldset.config-sync-target-fieldset', {}, [
          el('legend', { text: '目标主机（可多选）' }),
          el('div.config-sync-shortcuts', {}, [selectAllBtn, clearBtn]),
          targetCount,
          targetList,
        ]),
        status,
        errorSlot,
        resultSlot,
      ]),
      el('footer.config-sync-actions', {}, [closeBtn, previewBtn, applyBtn]),
    ]),
  ]);

  let source = '';
  let targets = new Set();
  let previewResult = null;
  let previewSignature = null;
  let applied = false;
  let generation = 0;
  let requestMode = null;
  let restoreFocus = null;
  let hostNamesKey = '';

  function hosts() {
    return store.listHosts();
  }

  function selectionSignature() {
    return JSON.stringify([source, [...targets]]);
  }

  function initialStatus() {
    return targets.size > 0
      ? '选择已就绪，请先预览变更。'
      : '请选择至少一台目标主机，然后先预览变更。';
  }

  function setStatus(message) {
    status.textContent = message;
  }

  function removeResults() {
    clear(resultSlot);
  }

  function clearError() {
    clear(errorSlot);
    errorSlot.hidden = true;
  }

  function renderError(error, fallback) {
    clear(errorSlot);
    errorSlot.append(el('p.config-sync-error-summary', {
      text: error?.summary || fallback,
    }));
    if (error?.detail) {
      errorSlot.append(el('details.config-sync-error-detail', {}, [
        el('summary', { text: '错误详情' }),
        el('pre', { text: error.detail }),
      ]));
    }
    errorSlot.hidden = false;
  }

  function invalidate(message) {
    const hadPreview = previewResult !== null || resultSlot.firstChild !== null || requestMode === 'preview';
    generation += 1;
    previewResult = null;
    previewSignature = null;
    applied = false;
    removeResults();
    clearError();
    setStatus(hadPreview ? message : initialStatus());
  }

  function renderSourceOptions(hostList) {
    clear(sourceSelect);
    for (const host of hostList) {
      sourceSelect.append(el('option', { value: host.name, text: host.name }));
    }
    sourceSelect.value = source;
  }

  function renderTargets(hostList) {
    const active = document.activeElement;
    const focusedHost = targetList.contains(active) ? active?.dataset?.host ?? null : null;
    clear(targetList);
    hostList.forEach((host, index) => {
      const id = `config-sync-target-${index}`;
      const input = el('input', {
        id,
        type: 'checkbox',
        dataset: { host: host.name },
        checked: targets.has(host.name),
        disabled: host.name === source,
      });
      input.addEventListener('change', () => {
        if (input.checked && targets.size >= CONFIG_SYNC_TARGET_LIMIT) {
          input.checked = false;
          setStatus(`一次最多选择 ${CONFIG_SYNC_TARGET_LIMIT} 台目标主机；请先取消一台再选择。`);
          syncControls();
          return;
        }
        if (input.checked) targets.add(host.name);
        else targets.delete(host.name);
        invalidate('选择已变化，请重新预览。');
        syncControls();
      });
      targetList.append(el('div.config-sync-target-row', { dataset: { name: host.name } }, [
        input,
        el('label', { for: id, text: host.name }),
      ]));
    });
    if (focusedHost) {
      const inputs = [...targetList.querySelectorAll('input')];
      const replacement = inputs.find((input) => input.dataset.host === focusedHost);
      const focusTarget = replacement && !replacement.disabled
        ? replacement
        : inputs.find((input) => !input.disabled) ?? sourceSelect;
      focusTarget.focus();
    }
  }

  function reconcileHosts({ force = false } = {}) {
    const hostList = hosts();
    const names = hostList.map((host) => host.name);
    const namesKey = JSON.stringify(names);
    const namesChanged = namesKey !== hostNamesKey;
    const previousSource = source;
    const previousTargets = [...targets];
    const valid = new Set(names);

    if (!valid.has(source)) source = names[0] ?? '';
    targets = new Set(
      previousTargets
        .filter((name) => valid.has(name) && name !== source)
        .slice(0, CONFIG_SYNC_TARGET_LIMIT),
    );
    const selectionChanged = source !== previousSource
      || previousTargets.length !== targets.size
      || previousTargets.some((name) => !targets.has(name));

    if (force || namesChanged) {
      hostNamesKey = namesKey;
      renderSourceOptions(hostList);
      renderTargets(hostList);
    }
    return { namesChanged, selectionChanged };
  }

  function syncControls() {
    const pending = store.isPending('config:sync');
    const canRequest = store.canWrite() && hosts().length >= 2 && Boolean(source) && targets.size > 0;
    targetCount.textContent = `已选 ${targets.size} / ${CONFIG_SYNC_TARGET_LIMIT} 台`;
    sourceSelect.disabled = pending;
    selectAllBtn.disabled = pending;
    clearBtn.disabled = pending;
    closeBtn.disabled = pending;
    for (const input of targetList.querySelectorAll('input')) {
      input.disabled = pending || input.dataset.host === source;
    }
    previewBtn.disabled = pending || !canRequest;
    applyBtn.disabled = pending
      || !store.canWrite()
      || applied
      || previewResult === null
      || previewSignature !== selectionSignature()
      || !previewResult.targets?.some((target) => target.changed);
  }

  function selectAll() {
    const available = hosts().filter((host) => host.name !== source);
    targets = new Set(available.slice(0, CONFIG_SYNC_TARGET_LIMIT).map((host) => host.name));
    invalidate('选择已变化，请重新预览。');
    if (available.length > CONFIG_SYNC_TARGET_LIMIT) {
      setStatus(`已按主机顺序选择前 ${CONFIG_SYNC_TARGET_LIMIT} 台目标主机。`);
    }
    renderTargets(hosts());
    syncControls();
  }

  function clearTargets() {
    targets.clear();
    invalidate('选择已变化，请重新预览。');
    renderTargets(hosts());
    syncControls();
  }

  sourceSelect.addEventListener('change', () => {
    source = sourceSelect.value;
    targets.delete(source);
    invalidate('选择已变化，请重新预览。');
    renderTargets(hosts());
    syncControls();
  });

  function orderedPlans(result, requestedTargets) {
    const byName = new Map((result?.targets ?? []).map((target) => [target.name, target]));
    return requestedTargets.map((name) => byName.get(name)).filter(Boolean);
  }

  function renderResults(result, requestedTargets) {
    removeResults();
    const list = el('ul.config-sync-result-list');
    for (const plan of orderedPlans(result, requestedTargets)) {
      const detail = plan.changed
        ? `将变更：${plan.changedFields.map((field) => FIELD_LABEL[field]).filter(Boolean).join('、') || '受支持配置字段'}`
        : '无需变更';
      const item = el('li.config-sync-result-item', { dataset: { host: plan.name } }, [
        el('strong', { text: plan.name }),
        el('span.config-sync-change-summary', { text: detail }),
      ]);
      const host = store.getHost(plan.name);
      if (plan.changed && RESTART_PHASES.has(host?.phase)) {
        item.append(el('span.config-sync-restart-note', { text: '状态提示：下次重启生效' }));
      }
      list.append(item);
    }
    resultSlot.append(el('section.config-sync-results', { 'aria-labelledby': 'config-sync-results-title' }, [
      el('h3', { id: 'config-sync-results-title', text: '同步预览' }),
      list,
      el('p.config-sync-no-restart', {
        text: '本动作不会重启或停止任何主机；运行中的配置将在下次重启生效。',
      }),
    ]));
  }

  async function preview() {
    if (previewBtn.disabled) return;
    const requested = { source, targets: [...targets] };
    const requestGeneration = generation;
    const signature = selectionSignature();
    requestMode = 'preview';
    previewResult = null;
    previewSignature = null;
    applied = false;
    removeResults();
    clearError();
    setStatus('正在预览配置差异…');

    let requestError = null;
    const result = await actions.syncConfig({
      ...requested,
      dryRun: true,
      onError: (error) => {
        requestError = error;
      },
    });
    requestMode = null;
    if (requestGeneration !== generation || signature !== selectionSignature()) {
      syncControls();
      return;
    }
    if (!result) {
      setStatus('预览失败，请修正后重试。');
      renderError(requestError, '预览配置差异失败');
      syncControls();
      return;
    }

    clearError();
    previewResult = result;
    previewSignature = signature;
    const changed = result.targets?.filter((target) => target.changed).length ?? 0;
    setStatus(changed > 0 ? `预览完成：${changed} 台主机有变更。` : '预览完成：目标配置已一致。');
    renderResults(result, requested.targets);
    syncControls();
  }

  async function apply() {
    if (applyBtn.disabled) return;
    const requested = { source, targets: [...targets] };
    generation += 1;
    const requestGeneration = generation;
    requestMode = 'apply';
    previewResult = null;
    previewSignature = null;
    applied = false;
    removeResults();
    clearError();
    setStatus('正在由服务端重新核对并应用配置…');

    let requestError = null;
    const result = await actions.syncConfig({
      ...requested,
      dryRun: false,
      onError: (error) => {
        requestError = error;
      },
    });
    requestMode = null;
    if (requestGeneration !== generation || !isOpen()) {
      syncControls();
      return;
    }
    if (!result) {
      setStatus('应用结果未确认，请重新预览后再试。');
      renderError(requestError, '应用配置同步失败');
      syncControls();
      return;
    }

    clearError();
    previewResult = result;
    applied = true;
    closeBtn.textContent = '关闭';
    const count = result.applied?.length ?? 0;
    setStatus(count > 0 ? `同步完成：已更新 ${count} 台主机。` : '同步完成：目标配置已一致。');
    renderResults(result, requested.targets);
    syncControls();
  }

  function open(trigger = null) {
    if (hosts().length < 2 || !store.canWrite() || store.isPending('config:sync')) return;
    restoreFocus = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    closeBtn.textContent = '取消';
    reconcileHosts({ force: true });
    invalidate('主机列表已变化，请重新预览。');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    syncControls();
    sourceSelect.focus();
  }

  function isOpen() {
    return dialog.open || dialog.hasAttribute('open');
  }

  function hide({ force = false, focusTarget = restoreFocus } = {}) {
    if (!force && store.isPending('config:sync')) return;
    generation += 1;
    requestMode = null;
    if (dialog.open) dialog.close();
    else dialog.removeAttribute('open');
    focusTarget?.focus?.();
    restoreFocus = null;
  }

  function close() {
    hide();
  }

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });

  const off = [
    store.on('pending:changed', syncControls),
    store.on('connection:changed', () => {
      if (isOpen() && !store.canWrite()) {
        hide({ force: true, focusTarget: document.querySelector('.manage-back') });
      }
      syncControls();
    }),
    store.on('hosts:changed', (name) => {
      if (!isOpen()) return;
      const related = name === source || targets.has(name);
      const { namesChanged, selectionChanged } = reconcileHosts();
      if (requestMode !== 'apply' && !applied && (related || namesChanged || selectionChanged)) {
        invalidate(namesChanged ? '主机列表已变化，请重新预览。' : '主机状态已变化，请重新预览。');
      }
      syncControls();
    }),
    store.on('hosts:reset', () => {
      if (!isOpen()) return;
      reconcileHosts({ force: true });
      if (requestMode !== 'apply' && !applied) invalidate('主机列表已变化，请重新预览。');
      syncControls();
    }),
  ];

  setStatus(initialStatus());
  syncControls();

  return {
    root: dialog,
    open,
    close,
    destroy() {
      for (const unsubscribe of off) unsubscribe();
      if (isOpen()) hide({ force: true, focusTarget: null });
    },
  };
}
