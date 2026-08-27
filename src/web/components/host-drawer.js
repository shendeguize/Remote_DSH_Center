/**
 * 主机详情抽屉（10 §3.3 / UI-19、UI-20、UI-21、UI-26）。
 *
 * 草稿纪律：打开时对 config 拍快照；SSE 更新运行态不覆盖用户未保存的草稿，
 * 只在 config 真变了时给冲突提示（UI-26）。
 */

import { DASH, button, clear, el, fmtAgo, phaseBadge, text } from '../utils.js';
import {
  buildHostPatch,
  deepEqual,
  diffPatch,
  field,
  formatEnvLines,
  formatLines,
  input,
  parseEnvLines,
  parseLines,
  parsePort,
  parseWorkdir,
  validatePatches,
} from '../form.js';
import { HOST_WEB_RESTART_NOTICE } from '../actions.js';
import { hostMappingSummary, hostPhaseMeta } from '../host-presentation.js';
import { buildInstallGuide } from '../install-guide.js';

const LOG_LINES = 200;
const REMOTE_CONFIG_NOTE = 'dsh Web 在目标主机运行；没有桌面环境也不影响内嵌页面。需要编辑 settings.yaml 时可直接使用下方“dsh 配置文件”编辑器，无需通过 SSH。';
const DRAFT_FIELDS = ['enabled', 'remoteWebPort', 'workdir', 'env', 'extraArgs', 'patches'];
const SETTINGS_UNKNOWN_CODES = new Set([
  'SSH_TIMEOUT',
  'SSH_UNREACHABLE',
  'LOCAL_TIMEOUT',
  'LOCAL_EXEC_FAILED',
  'LOCAL_COPY_FAILED',
  'PROTO_PARSE',
  'INTERNAL',
]);
const DRAFT_FIELD_LABELS = {
  enabled: '纳管状态',
  remoteWebPort: 'web 端口',
  workdir: '启动目录',
  env: '环境变量',
  extraArgs: '追加参数',
  patches: 'Patch 文件',
};

/**
 * config → 表单草稿（纯函数，便于单测草稿/冲突逻辑）。
 *
 * 端口一律存成字符串：草稿的另一半来自 `readForm()`，而 DOM 里的 value 永远是字符串。
 * 存成数字会让「配了显式端口的主机」一打开就被判脏——保存键亮着、Esc 还要确认放弃。
 */
export function draftOf(config) {
  return {
    enabled: Boolean(config?.enabled),
    remoteWebPort: config?.remoteWebPort == null ? '' : String(config.remoteWebPort),
    workdir: config?.workdir ?? '',
    env: formatEnvLines(config?.inject?.env),
    extraArgs: formatLines(config?.inject?.extraArgs),
    patches: formatLines(config?.inject?.patches),
  };
}

export function isDirty(draft, config) {
  return !deepEqual(draft, draftOf(config));
}

const LIVE_PHASES = ['running', 'degraded'];

/**
 * 「重启后生效」判定（纯函数）：已保存的启动目录与正在跑的实例不一致。
 *
 * 只有 workdir 能做这种值比对——state.web 记了本次实例的实际生效值；
 * env/extraArgs/patches 没有同款记录，故注入区只给静态提示，不假装能比对。
 */
export function workdirPending(host) {
  if (!LIVE_PHASES.includes(host?.phase) || !host?.web) return false;
  return (host.web.workdir ?? null) !== (host.config?.workdir ?? null);
}

export function workspaceRegistrationState(host, {
  canWrite = true,
  pending = false,
} = {}) {
  if (pending) {
    return { enabled: false, message: '正在登记启动目录…', tone: null };
  }
  const savedWorkdir = host?.config?.workdir ?? null;
  if (savedWorkdir === null) {
    return { enabled: false, message: '请先配置并保存启动目录。', tone: 'warn' };
  }
  if (!LIVE_PHASES.includes(host?.phase) || !host.web || !host.mappedUrl) {
    return {
      enabled: false,
      message: 'dsh web 实例未连接；连接后才能登记 Workspace。',
      tone: 'warn',
    };
  }
  if (host.tunnel?.connected !== true) {
    return {
      enabled: false,
      message: 'dsh web 隧道未连接；连接后才能登记 Workspace。',
      tone: 'warn',
    };
  }
  if ((host.web.workdir ?? null) !== savedWorkdir) {
    return {
      enabled: false,
      message: '请重启 dsh web，使当前实例应用已保存的启动目录。',
      tone: 'warn',
    };
  }
  if (
    host.web.cwd != null
    && (typeof host.web.cwd !== 'string' || !host.web.cwd.startsWith('/'))
  ) {
    return {
      enabled: false,
      message: 'dsh web 实际 CWD 不是绝对路径，无法登记 Workspace。',
      tone: 'warn',
    };
  }
  if (!canWrite) {
    return { enabled: false, message: 'manager 失联，登记已暂停。', tone: 'warn' };
  }
  if (host.web.cwd == null) {
    return {
      enabled: true,
      message: '实际 CWD 尚未上报；登记时将从 dsh Web 查询。',
      tone: null,
    };
  }
  return {
    enabled: true,
    message: '可登记已保存且当前实例已应用的启动目录。',
    tone: null,
  };
}

function comparableField(draft, key) {
  if (key === 'enabled') return Boolean(draft.enabled);
  if (key === 'remoteWebPort') {
    const parsed = parsePort(draft.remoteWebPort, { allowEmpty: true });
    return parsed.ok ? parsed.value : draft.remoteWebPort;
  }
  if (key === 'workdir') {
    const parsed = parseWorkdir(draft.workdir);
    return parsed.ok ? parsed.value : draft.workdir;
  }
  if (key === 'env') {
    const parsed = parseEnvLines(draft.env);
    return parsed.ok ? parsed.value : draft.env;
  }
  if (key === 'extraArgs') return parseLines(draft.extraArgs);
  const parsed = validatePatches(parseLines(draft.patches));
  return parsed.ok ? parsed.value : draft.patches;
}

function fieldEqual(left, right, key) {
  return deepEqual(comparableField(left, key), comparableField(right, key));
}

/**
 * 抽屉字段级三方合并（base = prevConfig，local = draft，remote = nextConfig）。
 *
 * inject 在 API 上是一个原子 patch，但在抽屉里 env / extraArgs / patches 各自拥有字段：
 * 未改字段跟随 remote，本地独改字段保留；双方同字段改成不同有效值才算冲突。
 */
export function reconcile(draft, prevConfig, nextConfig, priorConflicts = []) {
  const base = draftOf(prevConfig);
  const remote = draftOf(nextConfig);
  const merged = { ...draft };
  const unresolved = new Set(priorConflicts);
  const conflicts = [];
  let remoteChanged = false;

  for (const key of DRAFT_FIELDS) {
    const localChanged = !fieldEqual(draft, base, key);
    const fieldRemoteChanged = !fieldEqual(remote, base, key);
    const sameResult = fieldEqual(draft, remote, key);
    remoteChanged ||= fieldRemoteChanged;

    if (unresolved.has(key) && !sameResult) {
      conflicts.push(key);
    } else if (!localChanged || sameResult) {
      merged[key] = remote[key];
    } else if (fieldRemoteChanged) {
      conflicts.push(key);
    }
  }

  return { draft: merged, conflicts, remoteChanged };
}

/** 详情抽屉里随运输类型变化的标题与只读字段名。 */
export function drawerCopy(host) {
  if (host?.local === true) {
    return {
      portLabel: '本机 web 端口',
      probeTitle: '本机探测详情',
      logTitle: '本机日志',
      effectivePortLabel: '生效本机端口',
      processLabel: '本机进程',
      workdirLabel: '本机实际工作目录',
      configChanged: '本机配置已变化',
    };
  }
  return {
    portLabel: '远端 web 端口',
    probeTitle: '探测详情',
    logTitle: '远端日志',
    effectivePortLabel: '生效远端端口',
    processLabel: '进程',
    workdirLabel: '实际工作目录',
    configChanged: '远端配置已变化',
  };
}

export function createHostDrawer({ store, actions, confirm, setBackgroundInert = () => {} }) {
  const title = el('h2', { id: 'drawer-title' });
  const badge = el('div.drawer-badge');
  const conflict = el('p.card-notice', { hidden: true });

  const enabled = field('纳管此主机', input('checkbox', false));
  const remotePort = field('远端 web 端口', input('number', '', { min: '1', max: '65535', placeholder: '留空 = 用全局默认' }));
  const workdir = field(
    '启动目录（进程 CWD）',
    input('text', '', { placeholder: '~（家目录，默认）', spellcheck: 'false' }),
    { hint: '这是 dsh web 进程的 CWD；保存后需在下次拉起或重启时生效。新会话使用或恢复哪个 Workspace 由 dsh Web 自身决定。' },
  );
  const workdirBadge = el('span.pending-badge', { hidden: true, text: HOST_WEB_RESTART_NOTICE });
  workdir.root.querySelector('label').append(workdirBadge);
  const workspaceExplanation = el('p.section-note', {
    text: '已保存的启动目录可通过 dsh Web 官方 API 显式登记为 Workspace；此操作不修改 dsh CLI，也不改变 HOME，dsh Web 的目录选择器仍从 HOME 开始。',
  });
  const workspaceHint = el('p.field-hint');
  const workspaceStatus = el('p.dsh-settings-status', {
    role: 'status',
    'aria-live': 'polite',
  });
  const workspaceRegisterBtn = button('登记启动目录为 Workspace', {
    variant: 'primary',
    compact: false,
    disabled: true,
    onClick: () => registerWorkspace(),
  });
  const workspaceSection = el('section.config-section', {}, [
    el('h4', { text: 'dsh Workspace' }),
    workspaceExplanation,
    workspaceHint,
    workspaceStatus,
    el('div.dsh-settings-actions', {}, [workspaceRegisterBtn]),
  ]);
  const remoteConfigNote = el('p.section-note.remote-config-note', { hidden: true });
  const env = field('环境变量（每行 KEY=VALUE）', input('textarea', '', { rows: '4', spellcheck: 'false' }));
  const extraArgs = field('追加参数（每行一项，不做 shell 拆词）', input('textarea', '', { rows: '3', spellcheck: 'false' }));
  const patches = field('Patch 文件（每行一个本机绝对路径）', input('textarea', '', { rows: '3', spellcheck: 'false' }));
  const fields = [enabled, remotePort, workdir, env, extraArgs, patches];

  const saveBtn = button('保存', { variant: 'primary', compact: false, onClick: submit });
  const cancelBtn = button('放弃修改', { compact: false, onClick: () => resetDraft() });

  const probeDl = el('dl.kv');
  const probeTitle = el('h3', { text: '探测详情' });
  const probeGuideSummary = el('p.install-guide-summary');
  const probeGuideSteps = el('ol.install-guide-steps');
  const probeGuide = el('section.install-guide', { hidden: true }, [
    el('h3', { text: '安装与配置指引' }),
    probeGuideSummary,
    probeGuideSteps,
  ]);

  const settingsTextareaId = 'drawer-dsh-settings-content';
  const settingsTextarea = el('textarea.dsh-settings-content', {
    id: settingsTextareaId,
    disabled: true,
    rows: '12',
    spellcheck: 'false',
    autocomplete: 'off',
    autocapitalize: 'off',
  });
  const settingsPreservedTextarea = el('textarea.dsh-settings-preserved-content', {
    rows: '8',
    spellcheck: 'false',
    autocomplete: 'off',
    autocapitalize: 'off',
    'aria-label': '重新加载前的草稿（只读）',
  });
  settingsPreservedTextarea.readOnly = true;
  const settingsPreserved = el('details.dsh-settings-preserved', { hidden: true }, [
    el('summary', { text: '重新加载前的草稿（只读）' }),
    settingsPreservedTextarea,
  ]);
  const settingsPath = el('code.dsh-settings-path');
  const settingsStatus = el('p.dsh-settings-status', {
    role: 'status',
    'aria-live': 'polite',
  });
  const settingsLoadBtn = button('加载文件', {
    compact: false,
    onClick: () => loadSettings(),
  });
  const settingsSaveBtn = button('保存文件', {
    variant: 'primary',
    compact: false,
    disabled: true,
    onClick: () => saveSettings(),
  });
  const settingsDiscardBtn = button('放弃文件修改', {
    compact: false,
    disabled: true,
    onClick: () => resetSettingsDraft(),
  });
  const settingsSection = el('section.dsh-settings-editor', {}, [
    el('h3', { text: 'dsh 配置文件' }),
    el('p.dsh-settings-safety', {
      text: 'settings.yaml 可能包含凭据；内容仅在本页面内存中显示，不写入 manager 配置、日志或 SSE。',
    }),
    el('p.section-note', {
      text: '零侵入：只原子替换 settings.yaml，不修改 dsh CLI；当前 dsh 自行监视并加载，Center 不自动重启。',
    }),
    el('div.dsh-settings-path-row', {}, [
      el('span', { text: '解析路径（只读）' }),
      settingsPath,
    ]),
    el('label', { for: settingsTextareaId, text: '文件内容' }),
    settingsTextarea,
    settingsPreserved,
    settingsStatus,
    el('div.dsh-settings-actions', {}, [
      settingsLoadBtn,
      settingsSaveBtn,
      settingsDiscardBtn,
    ]),
  ]);

  const logPre = el('pre.remote-log-body', { text: '（未加载）' });
  const logBtn = button('拉取最近 200 行', { compact: false, onClick: () => loadLog() });
  const logTitle = el('h3', { text: '远端日志' });

  // 有校验器的字段（键名对齐 buildHostPatch 的 errors）
  const validated = {
    remoteWebPort: remotePort, workdir, env, patches,
  };

  // 离开字段就把它自己的校验结果说出来，不必等到点保存（issue #30）。
  // blur 不冒泡，所以只能挂在字段本身——挂到 form 上收不到。
  for (const [key, f] of Object.entries(validated)) {
    f.input.addEventListener('blur', () => {
      touched.add(key);
      revalidate();
    });
  }

  const form = el('form.drawer-form', {
    on: {
      submit: (e) => {
        e.preventDefault();
        submit();
      },
      input: () => syncDirty(),
      change: () => syncDirty(),
      // 离开字段就把它自己的校验结果说出来，不必等到点保存（issue #30）。
      // focusout 会冒泡，blur 不会——但垫片直接往 input 上派发 blur，两个都收。
    },
  }, [
    el('section.config-section', {}, [
      el('h3', { text: '基本配置' }),
      el('div.field-grid', {}, [enabled.root, remotePort.root]),
    ]),
    el('section.config-section.env-editor', {}, [
      el('h3', { text: '注入配置' }),
      el('p.section-note', { text: '本区改动保存后在下次拉起时生效，不影响正在跑的实例。' }),
      remoteConfigNote,
      workdir.root,
      workspaceSection,
      env.root,
      extraArgs.root,
      patches.root,
    ]),
    el('footer.drawer-actions', {}, [saveBtn, cancelBtn]),
  ]);

  const closeBtn = el('button.drawer-close', {
    type: 'button', 'aria-label': '关闭', text: '×', on: { click: () => requestClose() },
  });

  const root = el('aside.host-drawer', {
    'aria-labelledby': 'drawer-title',
    hidden: true,
    role: 'dialog',
    // 遮罩吞掉鼠标事件，那就是模态——说 false 会让读屏用户拿到相反的信息（issue #28）
    'aria-modal': 'true',
    on: {
      keydown: (e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onEsc(e);
      },
    },
  }, [
    el('header.drawer-header', {}, [el('div', {}, [title, badge]), closeBtn]),
    conflict,
    form,
    el('section.probe-detail', {}, [probeTitle, probeDl]),
    probeGuide,
    settingsSection,
    el('section.remote-log', {}, [
      logTitle,
      logPre,
      el('div.log-actions', {}, [logBtn]),
    ]),
  ]);

  const scrim = el('div.drawer-scrim', { hidden: true, on: { click: () => requestClose() } });

  let current = null; // { name, draft, config, conflicts }
  let restoreFocus = null;
  let closing = false;
  const touched = new Set(); // 碰过的字段才实时报错，见 revalidate

  settingsTextarea.addEventListener('input', () => {
    if (current) current.settings.editEpoch += 1;
    syncSettingsControls();
  });

  // ── 草稿 ─────────────────────────────────────────────────────────────

  function readForm() {
    return {
      enabled: enabled.input.checked,
      remoteWebPort: remotePort.input.value,
      workdir: workdir.input.value,
      env: env.input.value,
      extraArgs: extraArgs.input.value,
      patches: patches.input.value,
    };
  }

  function writeForm(draft) {
    enabled.input.checked = draft.enabled;
    remotePort.input.value = draft.remoteWebPort === null ? '' : String(draft.remoteWebPort);
    workdir.input.value = draft.workdir ?? '';
    env.input.value = draft.env;
    extraArgs.input.value = draft.extraArgs;
    patches.input.value = draft.patches;
    for (const f of fields) f.setError(null);
    touched.clear();
  }

  /**
   * 校验结果的展示纪律（issue #30）。
   *
   * 一个字段「被碰过」（离开过它，或点过保存）之后，它的错误提示就一直跟着值走：
   * 改对了立刻灭，改坏了立刻换成当前那条。没碰过的字段一声不吭——边打字边报太吵，
   * 刚敲下 `4` 就红一次没有意义。
   *
   * 原来的毛病是错误只在点保存时算一次、之后再没人碰：改回合法值，红字和
   * `aria-invalid` 还挂在那儿，读屏用户听到的仍是「无效」。
   */
  function revalidate() {
    if (!current) return;
    const built = buildHostPatch(current.draft);
    for (const [key, f] of Object.entries(validated)) {
      if (touched.has(key)) f.setError(built.errors?.[key] ?? null);
    }
    extraArgs.setError(null);
    return built;
  }

  function refreshConflict() {
    if (!current) return;
    const latest = draftOf(current.config);
    current.conflicts = current.conflicts.filter((key) => !fieldEqual(current.draft, latest, key));
    conflict.hidden = current.conflicts.length === 0;
    if (!conflict.hidden) {
      const host = store.getHost(current.name);
      const labels = current.conflicts.map((key) => DRAFT_FIELD_LABELS[key]).join('、');
      conflict.textContent = `${drawerCopy(host).configChanged}（可能来自另一个标签页）；同一字段（${labels}）也被修改。你的草稿已保留，保存已暂停；「放弃修改」可载入最新值。`;
    }
  }

  function syncDirty() {
    if (!current) return;
    current.draft = readForm();
    refreshConflict();
    revalidate();
    const dirty = isDirty(current.draft, current.config);
    const saving = store.isPending('config:save', current.name);
    for (const f of fields) f.input.disabled = saving;
    saveBtn.disabled = !dirty || current.conflicts.length > 0
      || !store.canWrite() || saving;
    cancelBtn.disabled = !dirty || saving;
    syncWorkspaceControls();
    syncSettingsControls();
  }

  function resetDraft() {
    if (!current) return;
    current.draft = draftOf(current.config);
    current.conflicts = [];
    writeForm(current.draft);
    syncDirty();
  }

  // ── 打开 / 关闭 ──────────────────────────────────────────────────────

  function open(name) {
    const host = store.getHost(name);
    if (!host) {
      store.addToast({ level: 'warn', summary: `主机 ${name} 不存在或尚未同步` });
      return;
    }
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    clearSettingsSession(current);
    clearWorkspaceSession();
    current = {
      name, config: host.config, draft: draftOf(host.config), conflicts: [],
      settings: {
        loaded: false,
        baselineContent: null,
        baselineChecksum: null,
        path: null,
        size: null,
        saveContent: null,
        editEpoch: 0,
        preserveOnReload: false,
      },
    };
    writeForm(current.draft);
    logPre.textContent = '（未加载）';
    renderReadonly(host);
    root.hidden = false;
    scrim.hidden = false;
    setBackgroundInert(true);
    syncDirty();
    closeBtn.focus();
    loadLog();
  }

  /**
   * Esc 的唯一入口。
   *
   * 「放弃未保存的修改？」是原生 `<dialog>`，`showModal()` 就在这一记 Esc 的处理器里调；
   * 浏览器随后处理同一记 Esc 的默认动作（CloseWatcher），一眼看到刚开的模态框就把它
   * 关掉——用户按 Esc 的体感是「毫无反应」，只能改用鼠标（issue #71）。所以要开框的
   * 那一记必须把默认动作摘掉。
   *
   * 反过来，确认框已经开着时这里一律不插手：那记 Esc 就该由框自己的原生 cancel 收场，
   * 再 preventDefault 就等于把 Esc 彻底焊死。
   */
  function onEsc(e) {
    if (closing) return;
    e.preventDefault?.();
    requestClose();
  }

  async function requestClose() {
    if (current && store.isPending('config:save', current.name)) {
      store.addToast({
        level: 'warn',
        summary: `${current.name} 配置正在保存，完成后再关闭；关闭不会取消写入`,
      });
      return;
    }
    if (current && store.isPending('settings:save', current.name)) {
      setSettingsStatus('保存正在进行，完成后再关闭；关闭不会取消写入。', 'warn');
      return;
    }
    if (current && store.isPending('workspace:register', current.name)) {
      setWorkspaceStatus('登记正在进行，完成后再关闭；关闭不会取消请求。', 'warn');
      return;
    }
    // 连按两下 Esc 不该弹出两个「放弃未保存的修改？」
    if (closing) return;
    closing = true;
    try {
      await confirmThenClose();
    } finally {
      closing = false;
    }
  }

  async function confirmThenClose() {
    const hostDirty = current && isDirty(current.draft, current.config);
    const fileDirty = settingsDirty(current);
    if (current && (hostDirty || fileDirty)) {
      const lines = [];
      if (hostDirty) lines.push(`${current.name} 的主机配置有改动尚未保存。`);
      if (fileDirty) lines.push(`${current.name} 的 dsh 配置文件有改动尚未保存。`);
      const ok = await confirm({
        title: '放弃未保存的修改？',
        lines,
        confirmLabel: '放弃',
      });
      if (!ok) return;
    }
    close();
  }

  function close() {
    root.hidden = true;
    scrim.hidden = true;
    setBackgroundInert(false);
    clearSettingsSession(current);
    clearWorkspaceSession();
    current = null;
    store.setDrawer({ open: false, host: null, dirty: false });
    const focusTarget = isUsableFocusTarget(restoreFocus)
      ? restoreFocus
      : findStableFocusTarget();
    focusTarget?.focus?.();
    restoreFocus = null;
  }

  function isUsableFocusTarget(node) {
    if (!node || node.disabled) return false;
    if (typeof node.isConnected === 'boolean') return node.isConnected;
    return typeof document.contains === 'function' ? document.contains(node) : false;
  }

  function findStableFocusTarget() {
    const manageBack = document.querySelector('.manage-back');
    if (isUsableFocusTarget(manageBack)) return manageBack;
    const brand = document.querySelector('.brand');
    if (isUsableFocusTarget(brand)) {
      brand.tabIndex = -1;
      return brand;
    }
    return isUsableFocusTarget(document.body) ? document.body : null;
  }

  // ── dsh Workspace ───────────────────────────────────────────────────

  function setWorkspaceStatus(message, tone = null) {
    workspaceStatus.textContent = message ?? '';
    if (tone) workspaceStatus.dataset.tone = tone;
    else delete workspaceStatus.dataset.tone;
  }

  function clearWorkspaceSession() {
    workspaceHint.textContent = '';
    setWorkspaceStatus('');
    workspaceRegisterBtn.disabled = true;
  }

  function syncWorkspaceControls() {
    if (!current) return;
    const host = store.getHost(current.name);
    if (!host) {
      clearWorkspaceSession();
      return;
    }
    const pending = store.isPending('workspace:register', current.name);
    const availability = workspaceRegistrationState(host, {
      canWrite: store.canWrite(),
      pending,
    });
    workspaceRegisterBtn.disabled = !availability.enabled;
    setWorkspaceStatus(availability.message, availability.tone);

    if (!isDirty(current.draft, current.config)) {
      workspaceHint.textContent = '';
      return;
    }
    const savedDraft = draftOf(current.config);
    const workdirDraftChanged = !fieldEqual(current.draft, savedDraft, 'workdir');
    workspaceHint.textContent = workdirDraftChanged
      ? '当前启动目录草稿尚未保存；登记仍使用已保存且当前实例已应用的目录。如要登记草稿值，请先保存并重启 dsh web。'
      : '主机配置有未保存修改；登记仍只使用已保存且当前实例已应用的启动目录。若修改启动目录，请先保存并重启 dsh web。';
  }

  async function registerWorkspace() {
    const session = current;
    if (!session) return;
    const host = store.getHost(session.name);
    const availability = workspaceRegistrationState(host, {
      canWrite: store.canWrite(),
      pending: store.isPending('workspace:register', session.name),
    });
    if (!availability.enabled) {
      syncWorkspaceControls();
      return;
    }

    setWorkspaceStatus('正在登记启动目录…');
    const body = await actions.registerDshWorkspace(session.name, {
      onError: (error) => {
        if (current === session) {
          setWorkspaceStatus(error?.summary || 'dsh Workspace 登记失败，请稍后重试。', 'error');
        }
      },
    });
    if (current !== session || !body) return;

    const path = typeof body.path === 'string' ? `：${body.path}` : '';
    setWorkspaceStatus(
      body.created
        ? `已登记启动目录为 Workspace${path}`
        : `该启动目录已经登记为 Workspace${path}`,
    );
  }

  // ── dsh settings 文件 ────────────────────────────────────────────────

  function settingsDirty(session = current) {
    return Boolean(
      session?.settings.loaded
      && settingsTextarea.value !== session.settings.baselineContent,
    );
  }

  function setSettingsStatus(message, tone = null) {
    settingsStatus.textContent = message ?? '';
    if (tone) settingsStatus.dataset.tone = tone;
    else delete settingsStatus.dataset.tone;
  }

  function updateDrawerDirty() {
    if (!current) return;
    store.setDrawer({
      dirty: isDirty(current.draft, current.config) || settingsDirty(current),
    });
  }

  function syncSettingsControls() {
    if (!current) return;
    const loaded = current.settings.loaded;
    const dirty = settingsDirty(current);
    const loading = store.isPending('settings:load', current.name);
    const saving = store.isPending('settings:save', current.name);

    settingsTextarea.disabled = !loaded || loading;
    settingsLoadBtn.disabled = loading || saving;
    settingsSaveBtn.disabled = !loaded || !dirty || !store.canWrite() || loading || saving;
    settingsDiscardBtn.disabled = !loaded || !dirty || loading || saving;
    updateDrawerDirty();
  }

  function clearPreservedSettingsDraft() {
    settingsPreservedTextarea.value = '';
    settingsPreserved.hidden = true;
    settingsPreserved.open = false;
  }

  function clearSettingsSession(session) {
    settingsTextarea.value = '';
    settingsTextarea.disabled = true;
    settingsPath.textContent = '';
    setSettingsStatus('');
    settingsLoadBtn.disabled = false;
    settingsSaveBtn.disabled = true;
    settingsDiscardBtn.disabled = true;
    clearPreservedSettingsDraft();
    if (!session?.settings) return;
    session.settings.loaded = false;
    session.settings.baselineContent = null;
    session.settings.baselineChecksum = null;
    session.settings.path = null;
    session.settings.size = null;
    session.settings.saveContent = null;
    session.settings.editEpoch = 0;
    session.settings.preserveOnReload = false;
  }

  function showSettingsLoadError(error) {
    setSettingsStatus(error?.summary || '读取失败，请稍后重试。', 'error');
  }

  function showSettingsSaveError(error) {
    if (error?.code === 'SETTINGS_STALE') {
      if (current) current.settings.preserveOnReload = true;
      setSettingsStatus('目标文件已变化；请重新加载后手工合并。你的草稿已保留。', 'warn');
      return;
    }
    if (error?.code === 'SETTINGS_BUSY') {
      setSettingsStatus('另一项文件操作进行中，请稍后重试。你的草稿已保留。', 'warn');
      return;
    }
    if (error?.status === 0 || SETTINGS_UNKNOWN_CODES.has(error?.code)) {
      if (current) current.settings.preserveOnReload = true;
      setSettingsStatus('保存结果未知；请重新加载后确认。你的草稿已保留。', 'warn');
      return;
    }
    setSettingsStatus(error?.summary || '保存失败，请稍后重试。', 'error');
  }

  async function loadSettings() {
    const session = current;
    if (!session
      || store.isPending('settings:load', session.name)
      || store.isPending('settings:save', session.name)) return;
    if (settingsDirty(session)) {
      const ok = await confirm({
        title: '重新加载 dsh 配置文件？',
        lines: [`${session.name} 有未保存的文件修改；重新加载会用当前文件覆盖草稿。`],
        confirmLabel: '重新加载',
      });
      if (!ok || current !== session) return;
    }

    const dirtyBeforeLoad = settingsDirty(session);
    const draftBeforeLoad = dirtyBeforeLoad ? settingsTextarea.value : null;
    const loadEpoch = session.settings.editEpoch;
    setSettingsStatus('正在读取文件…');
    const body = await actions.loadDshSettings(session.name, {
      onError: (error) => {
        if (current === session) showSettingsLoadError(error);
      },
    });
    if (current !== session) return;
    if (!body) {
      syncSettingsControls();
      return;
    }
    if (session.settings.editEpoch !== loadEpoch) {
      setSettingsStatus('加载期间草稿已变化；本次响应未覆盖内容，请确认草稿后再次加载。', 'warn');
      syncSettingsControls();
      return;
    }

    session.settings.loaded = true;
    session.settings.baselineContent = body.content;
    session.settings.baselineChecksum = body.checksum;
    session.settings.path = body.path;
    session.settings.size = body.size;
    settingsTextarea.value = body.content;
    settingsPath.textContent = body.path;
    if (dirtyBeforeLoad && session.settings.preserveOnReload) {
      settingsPreservedTextarea.value = draftBeforeLoad;
      settingsPreserved.hidden = false;
      settingsPreserved.open = false;
      setSettingsStatus('已重新加载目标文件；重新加载前的草稿已保留在下方，可手工对照合并。', 'warn');
    } else {
      clearPreservedSettingsDraft();
      setSettingsStatus(
        body.exists
          ? `已加载（${body.size} 字节）。`
          : '文件不存在；当前为空草稿，保存将创建 settings.yaml。',
      );
    }
    session.settings.preserveOnReload = false;
    syncSettingsControls();
  }

  async function saveSettings() {
    const session = current;
    if (!session
      || !session.settings.loaded
      || !settingsDirty(session)
      || !store.canWrite()
      || store.isPending('settings:load', session.name)
      || store.isPending('settings:save', session.name)) return;

    session.settings.saveContent = settingsTextarea.value;
    setSettingsStatus('正在保存文件…');
    const body = await actions.saveDshSettings(session.name, {
      content: session.settings.saveContent,
      baseChecksum: session.settings.baselineChecksum,
    }, {
      onError: (error) => {
        if (current === session) showSettingsSaveError(error);
      },
    });
    if (current !== session) {
      if (body && session.forcedHostRemoval) {
        store.addToast({
          level: 'success',
          summary: `${session.name} 的 dsh 配置文件已保存（主机详情已关闭）`,
        });
      }
      return;
    }

    const savedContent = session.settings.saveContent;
    session.settings.saveContent = null;
    if (!body) {
      syncSettingsControls();
      return;
    }

    session.settings.loaded = true;
    session.settings.baselineContent = savedContent;
    session.settings.baselineChecksum = body.checksum;
    session.settings.path = body.path;
    session.settings.size = body.size;
    settingsPath.textContent = body.path;
    session.settings.preserveOnReload = false;
    clearPreservedSettingsDraft();
    if (settingsTextarea.value !== savedContent) {
      setSettingsStatus('已保存提交时版本；当前仍有未保存修改。', 'warn');
    } else {
      setSettingsStatus(`已保存（${body.size} 字节）。`);
    }
    syncSettingsControls();
  }

  function resetSettingsDraft() {
    if (!current?.settings.loaded) return;
    settingsTextarea.value = current.settings.baselineContent;
    setSettingsStatus('已放弃文件修改，恢复到最近一次加载或保存的内容。');
    syncSettingsControls();
  }

  // ── 只读区 ───────────────────────────────────────────────────────────

  function renderReadonly(host) {
    const copy = drawerCopy(host);
    title.textContent = host.name;
    clear(badge).append(phaseBadge(hostPhaseMeta(host)));
    workdirBadge.hidden = !workdirPending(host);
    remotePort.root.querySelector('label').textContent = copy.portLabel;
    probeTitle.textContent = copy.probeTitle;
    logTitle.textContent = copy.logTitle;
    remoteConfigNote.hidden = host.local === true;
    remoteConfigNote.textContent = host.local === true ? '' : REMOTE_CONFIG_NOTE;

    const probe = host.probe;
    clear(probeDl);
    const rows = [
      ['dsh 路径', text(probe?.dshPath)],
      ['版本', text(probe?.version)],
      ['web profile', probe ? String(probe.profileWeb) : DASH],
      ['DSH_HOME', text(probe?.dshHome)],
      ['非交互 PATH', text(probe?.sniff?.probePath)],
      ['检测到的 dsh', Array.isArray(probe?.sniff?.paths) && probe.sniff.paths.length > 0
        ? probe.sniff.paths.join('\n')
        : DASH],
      ['login shell 检测', text(probe?.sniff?.loginPath)],
      ['嗅探版本', text(probe?.sniff?.version)],
      ['最近探测', probe?.at ? fmtAgo(probe.at) : DASH],
      [copy.effectivePortLabel, text(host.effectiveRemotePort)],
      ['本机映射', hostMappingSummary(host).url ?? DASH],
      [copy.processLabel, host.web ? `PID ${host.web.pid}（${host.web.startedByUs ? '本工具拉起' : '手动'}）` : DASH],
      // 实测工作目录：远端 /proc 不可读时为 null，此处退回「—」而不是编一个值
      [copy.workdirLabel, host.web ? (host.web.cwd ?? DASH) : DASH],
    ];
    if (probe?.errorSummary) rows.push(['探测错误', probe.errorSummary]);
    for (const [k, v] of rows) probeDl.append(el('dt', { text: k }), el('dd', { text: v }));

    if (host.phase === 'no_dsh') {
      const guide = buildInstallGuide({
        local: host.local === true,
        noDshReason: probe?.noDshReason,
        sniff: probe?.sniff,
        dshHome: probe?.dshHome,
      });
      probeGuideSummary.textContent = guide.summary;
      clear(probeGuideSteps);
      for (const step of guide.steps) {
        probeGuideSteps.append(el('li', {
          text: step.replaceAll('dshc probe <host>', `dshc probe ${host.name}`),
        }));
      }
      probeGuide.hidden = false;
    } else {
      probeGuide.hidden = true;
      clear(probeGuideSteps);
      probeGuideSummary.textContent = '';
    }
  }

  // ── 日志 ─────────────────────────────────────────────────────────────

  let logBusy = false;

  async function loadLog() {
    if (!current || logBusy) return;
    logBusy = true;
    logBtn.disabled = true;
    logBtn.textContent = '拉取中…';
    const name = current.name;
    const body = await actions.loadHostLog(name, LOG_LINES);
    logBusy = false;
    logBtn.disabled = false;
    logBtn.textContent = '刷新日志';
    if (!current || current.name !== name) return;
    // 失败不清空上一次成功内容（UI-21）
    if (body !== null) logPre.textContent = body === '' ? '（日志为空）' : body;
  }

  // ── 保存 ─────────────────────────────────────────────────────────────

  async function submit() {
    const session = current;
    if (!session || store.isPending('config:save', session.name)) return;
    // submit 以此刻 DOM 为准；input/change 事件与点击之间可能还有尚未同步进 draft 的值。
    session.draft = readForm();
    refreshConflict();
    if (session.conflicts.length > 0) return;
    // 保存是最终权威：该说的全说，之后这些字段也就都算碰过了
    for (const key of Object.keys(validated)) touched.add(key);
    const built = revalidate();
    if (!built.ok) return;

    // 只提交真正改动的键：避免把没碰过的字段“全量替换”回当前显示值
    const patch = diffPatch(built.value, session.config);
    if (Object.keys(patch).length === 0) {
      // raw 文本可能看似有变化，但 trim / 注释过滤后与服务端配置完全一致。
      // 回填 canonical draft，避免按钮与冲突提示继续暗示仍有内容可保存。
      resetDraft();
      store.addToast({ level: 'info', summary: '没有需要保存的有效变更' });
      return;
    }
    await actions.saveHostConfig(session.name, patch);
    if (current !== session) return;
    syncDirty();
  }

  // ── store 订阅 ───────────────────────────────────────────────────────

  function reconcileCurrentHost() {
    if (!current) return;
    const name = current.name;
    const host = store.getHost(name);
    if (!host) {
      const removedSession = current;
      removedSession.forcedHostRemoval = true;
      store.addToast({ level: 'warn', summary: `${name} 已从清单移除，详情已关闭` });
      confirm.cancel?.();
      close();
      return;
    }
    renderReadonly(host);
    const merged = reconcile(
      current.draft, current.config, host.config, current.conflicts,
    );
    const draftChanged = !deepEqual(current.draft, merged.draft);
    current.config = host.config;
    current.draft = merged.draft;
    current.conflicts = merged.conflicts;
    if (draftChanged) writeForm(current.draft);
    syncDirty();
  }

  const offs = [
    store.on('drawer:changed', (drawer) => {
      if (drawer.open && drawer.host && (!current || current.name !== drawer.host)) open(drawer.host);
    }),
    store.on('hosts:changed', (name) => {
      if (!current || current.name !== name) return;
      reconcileCurrentHost();
    }),
    store.on('hosts:reset', reconcileCurrentHost),
    store.on('pending:changed', syncDirty),
    store.on('connection:changed', syncDirty),
  ];

  // Esc 得在任何焦点位置都管用。抽屉元素上那个处理器 stopPropagation，
  // 所以焦点在抽屉里时这条不会重复触发。
  const onDocKeyDown = (e) => {
    if (e.key !== 'Escape' || root.hidden) return;
    onEsc(e);
  };
  document.addEventListener('keydown', onDocKeyDown);

  return {
    root,
    scrim,
    open,
    close,
    requestClose,
    get current() {
      return current;
    },
    destroy() {
      for (const off of offs) off();
      document.removeEventListener('keydown', onDocKeyDown);
      clearSettingsSession(current);
      clearWorkspaceSession();
      current = null;
    },
  };
}
