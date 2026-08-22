/**
 * 主机详情抽屉（10 §3.3 / UI-19、UI-20、UI-21、UI-26）。
 *
 * 草稿纪律：打开时对 config 拍快照；SSE 更新运行态不覆盖用户未保存的草稿，
 * 只在 config 真变了时给冲突提示（UI-26）。
 */

import { DASH, button, clear, el, fmtAgo, phaseBadge, text } from '../utils.js';
import { buildHostPatch, deepEqual, diffPatch, field, formatEnvLines, formatLines, input } from '../form.js';

const LOG_LINES = 200;

/**
 * config → 表单草稿（纯函数，便于单测草稿/冲突逻辑）。
 *
 * 端口一律存成字符串：草稿的另一半来自 `readForm()`，而 DOM 里的 value 永远是字符串。
 * 存成数字会让「配了显式端口的主机」一打开就被判脏——保存键亮着、Esc 还要确认放弃。
 */
export function draftOf(config) {
  return {
    enabled: Boolean(config?.enabled),
    autoStart: Boolean(config?.autoStart),
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

/**
 * 远端 config 变了该怎么办（UI-26）：草稿干净就直接跟随，脏就保留并提示。
 * @returns {'follow'|'conflict'|'none'}
 */
export function reconcile(draft, prevConfig, nextConfig) {
  if (deepEqual(prevConfig, nextConfig)) return 'none';
  return isDirty(draft, prevConfig) ? 'conflict' : 'follow';
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
  const autoStart = field('随 manager 自启', input('checkbox', false));
  const remotePort = field('远端 web 端口', input('number', '', { min: '1', max: '65535', placeholder: '留空 = 用全局默认' }));
  const workdir = field(
    '启动目录（工作区根）',
    input('text', '', { placeholder: '~（家目录，默认）', spellcheck: 'false' }),
    { hint: 'dsh 以此目录为默认 workspace 根，并从这里加载 AGENTS.md' },
  );
  const workdirBadge = el('span.pending-badge', { hidden: true, text: '重启后生效' });
  workdir.root.querySelector('label').append(workdirBadge);
  const env = field('环境变量（每行 KEY=VALUE）', input('textarea', '', { rows: '4', spellcheck: 'false' }));
  const extraArgs = field('追加参数（每行一项，不做 shell 拆词）', input('textarea', '', { rows: '3', spellcheck: 'false' }));
  const patches = field('Patch 文件（每行一个本机绝对路径）', input('textarea', '', { rows: '3', spellcheck: 'false' }));
  const fields = [enabled, autoStart, remotePort, workdir, env, extraArgs, patches];

  const saveBtn = button('保存', { variant: 'primary', compact: false, onClick: submit });
  const cancelBtn = button('放弃修改', { compact: false, onClick: () => resetDraft() });

  const probeDl = el('dl.kv');
  const probeTitle = el('h3', { text: '探测详情' });
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
      el('div.field-grid', {}, [enabled.root, autoStart.root, remotePort.root]),
    ]),
    el('section.config-section.env-editor', {}, [
      el('h3', { text: '注入配置' }),
      el('p.section-note', { text: '本区改动保存后在下次拉起时生效，不影响正在跑的实例。' }),
      workdir.root,
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
    el('section.remote-log', {}, [
      logTitle,
      logPre,
      el('div.log-actions', {}, [logBtn]),
    ]),
  ]);

  const scrim = el('div.drawer-scrim', { hidden: true, on: { click: () => requestClose() } });

  let current = null; // { name, draft, config }
  let restoreFocus = null;
  let closing = false;
  const touched = new Set(); // 碰过的字段才实时报错，见 revalidate

  // ── 草稿 ─────────────────────────────────────────────────────────────

  function readForm() {
    return {
      enabled: enabled.input.checked,
      autoStart: autoStart.input.checked,
      remoteWebPort: remotePort.input.value,
      workdir: workdir.input.value,
      env: env.input.value,
      extraArgs: extraArgs.input.value,
      patches: patches.input.value,
    };
  }

  function writeForm(draft) {
    enabled.input.checked = draft.enabled;
    autoStart.input.checked = draft.autoStart;
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

  function syncDirty() {
    if (!current) return;
    current.draft = readForm();
    revalidate();
    const dirty = isDirty(current.draft, current.config);
    store.setDrawer({ dirty });
    saveBtn.disabled = !dirty || !store.canWrite() || store.isPending('config:save', current.name);
    cancelBtn.disabled = !dirty;
  }

  function resetDraft() {
    if (!current) return;
    current.draft = draftOf(current.config);
    writeForm(current.draft);
    conflict.hidden = true;
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
    current = { name, config: host.config, draft: draftOf(host.config) };
    writeForm(current.draft);
    conflict.hidden = true;
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
    if (current && isDirty(current.draft, current.config)) {
      const ok = await confirm({
        title: '放弃未保存的修改？',
        lines: [`${current.name} 的注入配置有改动尚未保存。`],
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
    current = null;
    store.setDrawer({ open: false, host: null, dirty: false });
    restoreFocus?.focus?.();
    restoreFocus = null;
  }

  // ── 只读区 ───────────────────────────────────────────────────────────

  function renderReadonly(host) {
    const copy = drawerCopy(host);
    title.textContent = host.name;
    clear(badge).append(phaseBadge(host.phase));
    workdirBadge.hidden = !workdirPending(host);
    remotePort.root.querySelector('label').textContent = copy.portLabel;
    probeTitle.textContent = copy.probeTitle;
    logTitle.textContent = copy.logTitle;

    const probe = host.probe;
    clear(probeDl);
    const rows = [
      ['dsh 路径', text(probe?.dshPath)],
      ['版本', text(probe?.version)],
      ['web profile', probe ? String(probe.profileWeb) : DASH],
      ['DSH_HOME', text(probe?.dshHome)],
      ['最近探测', probe?.at ? fmtAgo(probe.at) : DASH],
      [copy.effectivePortLabel, text(host.effectiveRemotePort)],
      ['本机映射', host.mappedUrl ?? DASH],
      [copy.processLabel, host.web ? `PID ${host.web.pid}（${host.web.startedByUs ? '本工具拉起' : '手动'}）` : DASH],
      // 实测工作目录：远端 /proc 不可读时为 null，此处退回「—」而不是编一个值
      [copy.workdirLabel, host.web ? (host.web.cwd ?? DASH) : DASH],
    ];
    if (probe?.errorSummary) rows.push(['探测错误', probe.errorSummary]);
    for (const [k, v] of rows) probeDl.append(el('dt', { text: k }), el('dd', { text: v }));
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
    if (!current) return;
    // 保存是最终权威：该说的全说，之后这些字段也就都算碰过了
    for (const key of Object.keys(validated)) touched.add(key);
    const built = revalidate();
    if (!built.ok) return;

    // 只提交真正改动的键：避免把没碰过的字段“全量替换”回当前显示值
    const patch = diffPatch(built.value, current.config);
    if (Object.keys(patch).length === 0) {
      store.setDrawer({ dirty: false });
      return;
    }
    const res = await actions.saveHostConfig(current.name, patch);
    if (res?.host) {
      current.config = res.host.config;
      current.draft = draftOf(current.config);
      writeForm(current.draft);
      conflict.hidden = true;
      syncDirty();
    }
  }

  // ── store 订阅 ───────────────────────────────────────────────────────

  const offs = [
    store.on('drawer:changed', (drawer) => {
      if (drawer.open && drawer.host && (!current || current.name !== drawer.host)) open(drawer.host);
    }),
    store.on('hosts:changed', (name) => {
      if (!current || current.name !== name) return;
      const host = store.getHost(name);
      if (!host) {
        store.addToast({ level: 'warn', summary: `${name} 已从清单移除，详情已关闭` });
        close();
        return;
      }
      renderReadonly(host);
      const verdict = reconcile(current.draft, current.config, host.config);
      if (verdict === 'follow') {
        current.config = host.config;
        current.draft = draftOf(host.config);
        writeForm(current.draft);
      } else if (verdict === 'conflict') {
        conflict.hidden = false;
        conflict.textContent = `${drawerCopy(host).configChanged}（可能来自另一个标签页）；你的草稿已保留，「放弃修改」可载入最新值。`;
        current.config = host.config; // 冲突基准跟进，保存时按最新值 diff
      }
      syncDirty();
    }),
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
    },
  };
}
