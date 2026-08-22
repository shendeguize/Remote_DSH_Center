/**
 * 首启引导四步向导（10 §3.5 / UI-22…25）。
 *
 * 题目、校验、config 组装全部来自 `setup-schema.js`——与 `dshc init` 同源，
 * 页面这边只负责渲染、渐进探测展示、JSON 预览与端口迁移。
 *
 * 纪律：判定逻辑一律做成本文件顶部的纯函数（DOM-free，可单测），
 * `createSetupWizard` 只做装配与事件绑定。
 */

import { api as defaultApi } from '../api.js';
import {
  SETUP_STEPS,
  buildConfigFromAnswers,
  canAutoStart,
  defaultAnswers,
  getByPath,
  previewJson,
  setByPath,
  vPort,
  vRange,
} from '../setup-schema.js';
import { field, input } from '../form.js';
import { button, clear, copyText, el, phaseMeta } from '../utils.js';

/** 迁移探测的递增间隔（10 §3.5：60 秒兜底后停手）。 */
export const MIGRATION_DELAYS = Object.freeze([300, 500, 800, 1_200, 2_000, 3_000, 5_000]);
export const MIGRATION_BUDGET_MS = 60_000;

/** 探测未完成也允许进入第 4 步，但它们的 autoStart 只能是 false。 */
const PROBED = new Set(['ready', 'no_dsh', 'unreachable', 'running', 'degraded', 'crashed']);

/** 单步字段校验：只判本步，避免第 1 步就报第 2 步的错。 */
export function stepErrors(answers, step) {
  const errors = {};
  for (const f of step?.fields ?? []) {
    const bad = f.validate(getByPath(answers, f.key));
    if (bad) errors[f.key] = bad;
  }
  return errors;
}

/**
 * 勾选联动（01 §2.5 第 3 步）：取消纳管必然取消开启链接；
 * 只有探测为 ready 的主机才允许开启链接。
 */
export function nextSelection(selection, name, patch, host) {
  const prev = selection[name] ?? { enabled: true, autoStart: false };
  const enabled = patch.enabled ?? prev.enabled;
  let autoStart = patch.autoStart ?? prev.autoStart;
  if (!enabled) autoStart = false;
  if (autoStart && !canAutoStart(host)) autoStart = false;
  return { ...selection, [name]: { enabled, autoStart, touchedAutoStart: prev.touchedAutoStart || patch.autoStart !== undefined } };
}

/**
 * 探测结果到达后刷新勾选：新主机默认纳管；**首次**变为 ready 默认开启链接；
 * 离开 ready 的行强制收回 autoStart。用户手动动过的行不再被默认值覆盖。
 */
export function syncSelectionWithHosts(selection, hosts) {
  const next = {};
  for (const host of hosts) {
    const prev = selection[host.name];
    if (!prev) {
      next[host.name] = { enabled: true, autoStart: canAutoStart(host), touchedAutoStart: false };
      continue;
    }
    let autoStart = prev.autoStart;
    if (!prev.touchedAutoStart && canAutoStart(host)) autoStart = prev.enabled;
    if (!canAutoStart(host)) autoStart = false;
    next[host.name] = { ...prev, autoStart: prev.enabled ? autoStart : false };
  }
  return next;
}

/** 顶部「已完成 x / 总数 y」。 */
export function probeProgress(hosts) {
  return { done: hosts.filter((h) => PROBED.has(h.phase)).length, total: hosts.length };
}

export function pendingHosts(hosts, selection) {
  return hosts.filter((h) => !PROBED.has(h.phase) && (selection[h.name]?.enabled ?? true)).map((h) => h.name);
}

/** setup 表格里的本机不可用态不能沿用 SSH/远端语义。 */
export function setupPhaseLabel(host) {
  if (host?.local === true) {
    if (host.phase === 'unreachable') return '本机不可用';
    if (host.phase === 'no_dsh') return '本机未安装或未配置';
  }
  return phaseMeta(host?.phase).label;
}

/**
 * 第 4 步 JSON 预览的解析 + 前端基础结构校验（后端 schema 才是终裁）。
 * @returns {{ok:true, config:object}|{ok:false, error:string, line:number|null}}
 */
export function parsePreview(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `JSON 语法错误：${err.message}`, line: lineOfJsonError(text, err) };
  }
  const problems = structureProblems(parsed);
  if (problems.length > 0) return { ok: false, error: problems.join('；'), line: null };
  return { ok: true, config: parsed };
}

function structureProblems(cfg) {
  const bad = [];
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) return ['顶层必须是 JSON 对象'];
  if (!Number.isInteger(cfg.configVersion)) bad.push('缺少 configVersion');
  const portBad = vPort(cfg.manager?.port);
  if (portBad) bad.push(`manager.port ${portBad}`);
  const remoteBad = vPort(cfg.defaults?.remoteWebPort);
  if (remoteBad) bad.push(`defaults.remoteWebPort ${remoteBad}`);
  const rangeBad = vRange(cfg.defaults?.localPortRange);
  if (rangeBad) bad.push(`defaults.localPortRange ${rangeBad}`);
  if (cfg.hosts === null || typeof cfg.hosts !== 'object' || Array.isArray(cfg.hosts)) bad.push('hosts 必须是对象');
  return bad;
}

/** JSON.parse 只给字符偏移，人要看的是行号。 */
export function lineOfJsonError(text, err) {
  const m = /position (\d+)/.exec(err.message ?? '');
  if (!m) return null;
  const pos = Math.min(Number(m[1]), text.length);
  return text.slice(0, pos).split('\n').length;
}

/**
 * 端口迁移目标（10 §3.5）：端口没改就不迁移；改了就用**用户提交的端口**
 * 拼目标 origin——绝不硬编码。
 */
export function migrationTarget(submittedPort, currentOrigin) {
  const url = new URL(currentOrigin);
  if (String(submittedPort) === (url.port || (url.protocol === 'https:' ? '443' : '80'))) return null;
  return `${url.protocol}//${url.hostname}:${submittedPort}`;
}

// ── 组件 ─────────────────────────────────────────────────────────────────

const sleepDefault = (ms) => new Promise((r) => {
  const t = setTimeout(r, ms);
  t?.unref?.();
});

/**
 * @param {{
 *   store: object, actions: object, confirm: Function,
 *   api?: object, win?: Window, sleep?: (ms:number)=>Promise<void>,
 * }} deps
 */
export function createSetupWizard({
  store, actions, confirm, api = defaultApi, win = globalThis.window, sleep = sleepDefault,
}) {
  const ui = {
    step: 0,
    answers: null,
    answersFrom: null,
    touched: false,
    selection: {},
    previewText: '',
    previewDirty: false,
    previewError: null,
    /** 输入框里「还没解析成合法值」的原始错误：它们同样要挡住下一步。 */
    rawErrors: {},
    submitting: false,
    discovered: false,
    migration: null, // { target, elapsedMs, stopped }
    frozen: null, // 提交快照：确认后迟到的探测结果不得改它
  };

  // 焦点已经安放在第几步（初值等于起始步，免得首屏就把焦点从别处抢过来）
  let focusedStep = ui.step;

  const stepper = el('ol.stepper', { 'aria-label': '初始化步骤' });
  const panel = el('form.step-panel', { novalidate: 'novalidate' });
  const foot = el('footer.wizard-foot');
  const notice = el('p.wizard-notice', { role: 'status', hidden: true });
  const root = el('main.view.setup-wizard', { hidden: true }, [
    el('header.wizard-head', {}, [
      el('h1', { text: '初始化 DSH Center' }),
      el('p.wizard-sub', { text: '四步完成本机与远端约定，随后即可纳管主机' }),
    ]),
    stepper,
    notice,
    panel,
    foot,
  ]);

  panel.addEventListener('submit', (ev) => ev.preventDefault());

  /**
   * 现值来源：manager info 的实际端口 + `GET /api/config`（setup 模式白名单内）下发的
   * defaults——首启时后端那份就是出厂默认表。前端不留第二份常量：拿不到就留空让用户填，
   * 抄一份端口常量在这里，迟早和 `src/defaults.js` 对不上。
   */
  function currentConfig() {
    const info = store.state.manager.info;
    const defaults = store.state.defaults;
    return {
      manager: { port: info?.port ?? null },
      defaults: {
        remoteWebPort: defaults?.remoteWebPort ?? null,
        localPortRange: defaults?.localPortRange ?? null,
      },
    };
  }

  /**
   * 用户没动过之前，预填值跟着后端现值走：向导可能在 manager info / config 到达之前
   * 就渲染了一拍，把那一拍的空值定死会让现值永远填不进来。
   */
  function ensureAnswers() {
    const current = currentConfig();
    const from = JSON.stringify(current);
    // 只在「现值真的变了」时重建：无条件重建会在同一次渲染里换掉答案对象，
    // 输入框回写的就成了上一份草稿。
    if (!ui.answers || (!ui.touched && from !== ui.answersFrom)) {
      ui.answers = defaultAnswers(current);
      ui.answersFrom = from;
    }
    return ui.answers;
  }

  // ── 第 3 步：候选发现与并行探测 ──────────────────────────────────────
  async function discover() {
    if (ui.discovered) return;
    ui.discovered = true;
    try {
      const res = await api.hosts();
      store.mergeFetchedHosts(res.hosts, res.revision, performance.now());
      ui.selection = syncSelectionWithHosts(ui.selection, store.listHosts());
      render();
    } catch (err) {
      actions.reportError(err, '读取候选主机失败');
      ui.discovered = false;
      return;
    }
    try {
      await api.probeAll();
    } catch (err) {
      actions.reportError(err, '发起探测失败（可稍后在管理台重试）');
    }
  }

  function onHostsChanged() {
    if (ui.frozen) return; // 提交快照已冻结，迟到结果只影响显示
    ui.selection = syncSelectionWithHosts(ui.selection, store.listHosts());
    if (ui.step === 2) render();
  }

  // ── 渲染 ────────────────────────────────────────────────────────────
  function renderStepper() {
    clear(stepper);
    SETUP_STEPS.forEach((step, i) => {
      stepper.append(el('li.step', {
        dataset: { state: i === ui.step ? 'current' : (i < ui.step ? 'done' : 'todo') },
        'aria-current': i === ui.step ? 'step' : null,
        text: `${i + 1}. ${step.title}`,
      }));
    });
  }

  function renderFields(step) {
    const answers = ensureAnswers();
    const rows = [];
    for (const f of step.fields) {
      // 输入框按答案重建，之前那次「输错了还没改回来」的记录随之作废
      delete ui.rawErrors[f.key];
      const value = getByPath(answers, f.key);
      const missing = value === null || value === undefined;
      const shown = missing ? '' : (f.format ? f.format(value) : String(value));
      const box = field(f.label, input('text', shown, {
        inputmode: 'numeric',
        'data-key': f.key,
        on: {
          input: (ev) => {
            ui.touched = true; // 用户接手之后，后端的现值不再回灌覆盖
            const parsed = f.parse(ev.target.value);
            const bad = parsed.ok ? f.validate(parsed.value) : parsed.error;
            box.setError(bad);
            if (bad) {
              // 非法输入不写回答案（避免污染），但必须挡住「下一步」
              ui.rawErrors[f.key] = bad;
            } else {
              delete ui.rawErrors[f.key];
              setByPath(answers, f.key, parsed.value);
              ui.previewDirty = false; // 结构化改动后预览需重生成
            }
            syncFoot();
          },
        },
      }), { hint: f.hint });
      rows.push(box);
      panel.append(box.root);
    }
    return rows;
  }

  function renderHostStep() {
    const hosts = store.listHosts();
    const { done, total } = probeProgress(hosts);
    panel.append(el('p.wizard-progress', {
      role: 'status',
      text: total === 0 ? '~/.ssh/config 里没有候选主机；可先完成配置，之后补充。' : `已完成探测 ${done} / 共 ${total}`,
    }));
    if (total === 0) return;

    const table = el('table.setup-hosts', {}, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '主机' }),
        el('th', { text: '探测状态' }),
        el('th', { text: '纳管' }),
        el('th', { text: '开启链接' }),
      ])]),
    ]);
    const body = el('tbody');
    for (const host of hosts) {
      const pick = ui.selection[host.name] ?? { enabled: true, autoStart: false };
      const meta = phaseMeta(host.phase);
      const phaseLabel = setupPhaseLabel(host);
      const probing = !PROBED.has(host.phase);
      const enabledBox = input('checkbox', pick.enabled, {
        'aria-label': `纳管 ${host.name}`,
        on: {
          change: (ev) => {
            ui.selection = nextSelection(ui.selection, host.name, { enabled: ev.target.checked }, host);
            render();
          },
        },
      });
      const autoBox = input('checkbox', pick.autoStart, {
        'aria-label': `开启链接 ${host.name}`,
        on: {
          change: (ev) => {
            ui.selection = nextSelection(ui.selection, host.name, { autoStart: ev.target.checked }, host);
            render();
          },
        },
      });
      // 只有 ready 能开启链接；探测中/不可用的行禁用该勾选框但仍可改纳管
      autoBox.disabled = !pick.enabled || !canAutoStart(host);
      body.append(el('tr', { dataset: { host: host.name, probing: probing ? 'yes' : 'no' } }, [
        el('td', {}, [
          el('span', { text: host.name }),
          host.local ? el('span.tag.tag-lock', { text: '本机' }) : null,
        ]),
        el('td.probe-cell', {}, [el('span.phase-badge', { dataset: { tone: meta.tone }, text: probing ? '探测中' : phaseLabel })]),
        el('td', {}, [enabledBox]),
        el('td', {}, [autoBox]),
      ]));
    }
    table.append(body);
    panel.append(table);
    // 不给向导加第 5 步（四步承诺，01 §2.5）：启动目录是 per-host 的事后配置项
    panel.append(el('p.wizard-note', {
      text: '各主机的启动目录（远端工作区根）可稍后在主机详情中配置，默认为远端家目录。',
    }));
  }

  function buildConfigNow() {
    const hosts = store.listHosts();
    const probeResults = Object.fromEntries(hosts.map((h) => [h.name, { phase: h.phase }]));
    return buildConfigFromAnswers(
      ensureAnswers(),
      hosts.map((host) => ({ name: host.name, local: host.local === true })),
      probeResults,
      { hostDefaults: { localPort: null, remoteWebPort: null, workdir: null } },
      { selection: ui.selection },
    );
  }

  function renderPreview() {
    if (!ui.previewDirty) ui.previewText = previewJson(buildConfigNow());
    const box = field('完整配置（可直接编辑）', input('textarea', ui.previewText, {
      rows: '18',
      spellcheck: 'false',
      'aria-label': '配置 JSON 预览',
      on: {
        input: (ev) => {
          ui.previewDirty = true;
          ui.previewText = ev.target.value;
          const res = parsePreview(ui.previewText);
          ui.previewError = res.ok ? null : res;
          box.setError(res.ok ? null : `${res.error}${res.line ? `（第 ${res.line} 行）` : ''}`);
          syncFoot();
        },
      },
    }), { hint: '内容即提交体；手改后以这里为准' });
    if (ui.previewError) box.setError(`${ui.previewError.error}${ui.previewError.line ? `（第 ${ui.previewError.line} 行）` : ''}`);
    panel.append(box.root);

    const waiting = pendingHosts(store.listHosts(), ui.selection);
    if (waiting.length > 0) {
      panel.append(el('p.wizard-warn', {
        text: `仍有 ${waiting.length} 台探测未完成：将按当前纳管选择保存，开启链接一律关闭。`,
      }));
    }
  }

  function renderMigration() {
    const { target, stopped } = ui.migration;
    clear(panel).append(
      el('p.wizard-progress', {
        role: 'status',
        text: stopped
          ? '等待新端口超时。manager 可能仍在重启，可重试或手动打开新地址。'
          : `配置已保存。manager 正在切到新端口，正在等待 ${target} 就绪…`,
      }),
      el('p.mono.migration-target', { text: `${target}/` }),
    );
    clear(foot).append(
      button('重试', { compact: false, variant: 'primary', disabled: !stopped, onClick: () => pollMigration(target) }),
      button('复制新地址', { compact: false, onClick: () => copyText(`${target}/`) }),
    );
    clear(stepper);
  }

  function syncFoot() {
    clear(foot);
    const step = SETUP_STEPS[ui.step];
    const errors = stepErrors(ensureAnswers(), step);
    const rawBad = (step.fields ?? []).some((f) => ui.rawErrors[f.key]);
    const blocked = Object.keys(errors).length > 0 || rawBad;
    const last = ui.step === SETUP_STEPS.length - 1;

    if (ui.step > 0) {
      foot.append(button('上一步', {
        compact: false,
        disabled: ui.submitting,
        onClick: () => goBack(),
      }));
    }
    if (!last) {
      foot.append(button('下一步', {
        compact: false,
        variant: 'primary',
        disabled: blocked,
        onClick: () => goNext(),
      }));
    } else {
      foot.append(button(ui.submitting ? '提交中…' : '完成并保存', {
        compact: false,
        variant: 'primary',
        disabled: ui.submitting || Boolean(ui.previewError),
        onClick: () => submit(),
      }));
    }
    // 首次 setup 没有「退出到管理台」的口子（10 §5.2）；重新配置才给取消
    if (store.state.manager.setupCompleted === true) {
      foot.append(el('a.link', { href: '#/', text: '取消，返回管理台' }));
    }
  }

  function render() {
    if (ui.migration) {
      renderMigration();
      return;
    }
    renderStepper();
    const had = panel.contains(document.activeElement) ? document.activeElement : null;
    const hadLabel = had?.getAttribute?.('aria-label') ?? null;
    clear(panel);
    const step = SETUP_STEPS[ui.step];
    const title = el('h2.step-title', { text: `${ui.step + 1}. ${step.title}`, tabindex: '-1' });
    panel.append(title);
    if (step.fields) renderFields(step);
    else if (step.kind === 'host-select') renderHostStep();
    else renderPreview();
    syncFoot();

    // 换步要把焦点带过去。整块面板是重建的，按下「下一步」的那个按钮随即被移除，
    // 焦点于是落回 body——键盘用户每一步都得从文档顶部重新 Tab 起。焦点给标题
    // （而不是第一个输入框）：读屏先念出「第几步·做什么」，再 Tab 就是第一个字段。
    // 只在真的换步时动，别在字段校验、主机探测这些重渲染里抢焦点。
    if (focusedStep !== ui.step) {
      focusedStep = ui.step;
      title.focus();
    } else if (had && document.activeElement !== had) {
      // 同一步里的重渲染也会吃掉焦点：进第 3 步后候选异步到达要再渲一次，
      // 每台主机探测完也各渲一次。能认出原来那个控件（勾选框都有 aria-label）
      // 就还给它，认不出就退回标题——总之别让焦点掉回文档顶端。
      const same = hadLabel
        ? [...panel.querySelectorAll('[aria-label]')].find((n) => n.getAttribute('aria-label') === hadLabel)
        : null;
      (same && !same.disabled ? same : title).focus();
    }
  }

  function goNext() {
    const step = SETUP_STEPS[ui.step];
    if (Object.keys(stepErrors(ensureAnswers(), step)).length > 0) return;
    if ((step.fields ?? []).some((f) => ui.rawErrors[f.key])) return;
    ui.step = Math.min(ui.step + 1, SETUP_STEPS.length - 1);
    if (SETUP_STEPS[ui.step].kind === 'host-select') discover();
    render();
  }

  /** 从第 4 步回退：先把手改的 JSON 回灌结构化草稿，解析失败则不许退。 */
  function goBack() {
    if (SETUP_STEPS[ui.step].kind === 'preview' && ui.previewDirty) {
      const res = parsePreview(ui.previewText);
      if (!res.ok) {
        ui.previewError = res;
        render();
        actions.reportError(new Error(res.error), 'JSON 无法解析，先修好再返回');
        return;
      }
      ui.touched = true; // 手改过的 JSON 就是用户意图，别再被后端现值回灌
      const answers = ensureAnswers();
      setByPath(answers, 'manager.port', res.config.manager.port);
      setByPath(answers, 'defaults.remoteWebPort', res.config.defaults.remoteWebPort);
      setByPath(answers, 'defaults.localPortRange', [...res.config.defaults.localPortRange]);
      for (const [name, hostCfg] of Object.entries(res.config.hosts ?? {})) {
        ui.selection[name] = {
          enabled: Boolean(hostCfg.enabled),
          autoStart: Boolean(hostCfg.autoStart),
          touchedAutoStart: true,
        };
      }
      ui.previewDirty = false;
      ui.previewError = null;
    }
    ui.step = Math.max(ui.step - 1, 0);
    render();
  }

  async function submit() {
    const parsed = ui.previewDirty ? parsePreview(ui.previewText) : { ok: true, config: buildConfigNow() };
    if (!parsed.ok) {
      ui.previewError = parsed;
      render();
      return;
    }

    const waiting = pendingHosts(store.listHosts(), ui.selection);
    if (waiting.length > 0) {
      const ok = await confirm({
        title: '仍有主机未完成探测',
        lines: [
          `仍有 ${waiting.length} 台探测未完成：${waiting.join('、')}。`,
          '它们将按当前纳管选择保存，开启链接保持关闭。',
        ],
        confirmLabel: '仍然保存',
        danger: false,
      });
      if (!ok) return;
    }

    ui.frozen = parsed.config; // 冻结快照：之后到达的探测结果不得改提交内容
    ui.submitting = true;
    store.emit('setup:changed', { submitting: true });
    render();

    try {
      const res = await api.setup(ui.frozen);
      const target = res.portChanged ? migrationTarget(res.port, win.location.origin) : null;
      if (target) {
        ui.migration = { target, stopped: false };
        store.emit('setup:changed', { migrating: true, target });
        render();
        pollMigration(target);
        return;
      }
      store.addToast({ level: 'success', summary: '配置已保存', timeoutMs: 4_000 });
      if (res.restartRequired) {
        store.addToast({ level: 'warning', summary: '前台模式下需在终端重启 manager 才能生效' });
      }
      // 端口没变：拿最新 info 撤掉 setup 守卫，再回管理台
      try {
        store.setManagerInfo(await api.managerInfo());
      } catch { /* 守卫会在下次刷新时纠正 */ }
      actions.navigate('#/');
    } catch (err) {
      actions.reportError(err, '保存配置失败');
      ui.frozen = null;
    } finally {
      ui.submitting = false;
      ui.previewDirty = false;
      store.emit('setup:changed', { submitting: false });
      if (!ui.migration) render();
    }
  }

  /** 只探测目标 origin，绝不重复 POST /api/setup（10 §7 场景 19）。 */
  async function pollMigration(target) {
    ui.migration = { target, stopped: false };
    render();
    const startedAt = performance.now(); // 单调钟：预算是「过了多久」（#104）
    for (let i = 0; performance.now() - startedAt < MIGRATION_BUDGET_MS; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- 递增间隔的顺序探测
      await sleep(MIGRATION_DELAYS[Math.min(i, MIGRATION_DELAYS.length - 1)]);
      // eslint-disable-next-line no-await-in-loop -- 同上
      const info = await api.probeOrigin(target);
      if (info?.setupCompleted === true) {
        win.location.replace(`${target}/#/`);
        return;
      }
    }
    ui.migration = { target, stopped: true };
    render();
  }

  const offHosts = store.on('hosts:changed', onHostsChanged);
  const offReset = store.on('hosts:reset', onHostsChanged);
  const offManager = store.on('manager:changed', () => {
    if (!root.hidden && !ui.migration) syncFoot();
  });

  render();

  return {
    root,
    /** 路由切到 #/setup 时调用：进入即渲染，重新配置时预填现值。 */
    open() {
      root.hidden = false;
      render();
    },
    close() {
      root.hidden = true;
    },
    destroy() {
      offHosts();
      offReset();
      offManager();
    },
    // 测试用视图
    _ui: ui,
  };
}
