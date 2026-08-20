/**
 * 首启引导的「问题定义」——CLI 向导与页面向导共用的唯一源（11 §6.3 / ENG-17）。
 *
 * 硬约束：纯数据 + 纯函数，不引 DOM、不引 node API，也不 import 项目里任何带副作用的模块。
 * 页面用 <script type=module> 直接 import；cli.js 以文件路径 import。
 */

export const PORT_MIN = 1;
export const PORT_MAX = 65_535;

export function parseIntStrict(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d+$/.test(s)) return { ok: false, error: '请输入整数' };
  return { ok: true, value: Number(s) };
}

export function vPort(n) {
  if (!Number.isInteger(n) || n < PORT_MIN || n > PORT_MAX) return `端口须为 ${PORT_MIN}–${PORT_MAX} 的整数`;
  return null;
}

/** `17701-17799`、`17701 17799`、`17701,17799` 都收。 */
export function parseRange(raw) {
  const parts = String(raw ?? '').split(/[\s,\-–~]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) return { ok: false, error: '请输入两个端口，如 17701-17799' };
  const from = parseIntStrict(parts[0]);
  const to = parseIntStrict(parts[1]);
  if (!from.ok) return from;
  if (!to.ok) return to;
  return { ok: true, value: [from.value, to.value] };
}

export function vRange(range) {
  if (!Array.isArray(range) || range.length !== 2) return '区间需要起点与终点两个值';
  for (const p of range) {
    const bad = vPort(p);
    if (bad) return bad;
  }
  if (range[1] < range[0]) return '区间终点必须 ≥ 起点';
  return null;
}

/**
 * 四步定义，与 01 §2.5 一一对应。
 * `def(current)` 取预填值：current 是「现有 config 或出厂默认」的同形对象。
 */
export const SETUP_STEPS = Object.freeze([
  {
    id: 'manager',
    title: '本机服务',
    fields: [
      {
        key: 'manager.port',
        label: 'manager 端口',
        hint: '管理台与 API 的本机监听端口',
        def: (c) => c.manager.port,
        parse: parseIntStrict,
        validate: vPort,
      },
      {
        key: 'defaults.localPortRange',
        label: '本机映射端口区间',
        hint: '每台远端主机从这个区间里分一个本机端口，如 17701-17799',
        def: (c) => c.defaults.localPortRange,
        parse: parseRange,
        validate: vRange,
        format: (v) => `${v[0]}-${v[1]}`,
      },
    ],
  },
  {
    id: 'remote',
    title: '远端约定',
    fields: [
      {
        key: 'defaults.remoteWebPort',
        label: '远端 dsh web 端口',
        hint: '统一约定值；个别主机可事后单独覆写',
        def: (c) => c.defaults.remoteWebPort,
        parse: parseIntStrict,
        validate: vPort,
      },
    ],
  },
  { id: 'hosts', title: '主机纳管与开启', kind: 'host-select' },
  { id: 'confirm', title: '确认', kind: 'preview' },
]);

/** 按 `a.b` 点路径取值，两侧向导共用同一套 key 字符串。 */
export function getByPath(obj, keyPath) {
  return keyPath.split('.').reduce((acc, k) => (acc === null || acc === undefined ? acc : acc[k]), obj);
}

export function setByPath(obj, keyPath, value) {
  const keys = keyPath.split('.');
  const last = keys.pop();
  let cur = obj;
  for (const k of keys) {
    cur[k] ??= {};
    cur = cur[k];
  }
  cur[last] = value;
  return obj;
}

/** 收集所有字段的预填答案（一路回车即得此结果）。 */
export function defaultAnswers(current) {
  const answers = {};
  for (const step of SETUP_STEPS) {
    for (const f of step.fields ?? []) setByPath(answers, f.key, f.def(current));
  }
  return answers;
}

/**
 * 逐字段校验答案；返回按 key 的错误表（空表 = 全通过）。
 * 两侧向导共用，保证「同源同题同判定」。
 */
export function validateAnswers(answers) {
  const errors = {};
  for (const step of SETUP_STEPS) {
    for (const f of step.fields ?? []) {
      const bad = f.validate(getByPath(answers, f.key));
      if (bad) errors[f.key] = bad;
    }
  }
  return errors;
}

/**
 * 主机勾选规则（01 §2.5 第 3 步 / UI-23）：只有探测为 ready 才能开启链接；
 * 探测未完成的行可以纳管，但 autoStart 一律 false。
 * @param {{phase?:string}|null} probe
 */
export function canAutoStart(probe) {
  return probe?.phase === 'ready';
}

/**
 * answers + ssh 主机清单 + 探测结果 → 完整 config（setupCompleted 由落盘侧强制置 true）。
 *
 * @param {object} answers 形如 { manager:{port}, defaults:{remoteWebPort, localPortRange} }
 * @param {string[]} sshHosts ssh config 里的候选主机名
 * @param {Record<string, {phase?:string}>} probeResults 主机名 → 探测结果（可缺）
 * @param {object} factoryDefaults 出厂默认（提供 hostDefaults 形状）
 * @param {{selection?:Record<string,{enabled?:boolean, autoStart?:boolean}>}} [opts]
 */
export function buildConfigFromAnswers(answers, sshHosts, probeResults, factoryDefaults, opts = {}) {
  const selection = opts.selection ?? {};
  const hostDefaults = factoryDefaults.hostDefaults;

  const hosts = {};
  for (const name of sshHosts) {
    const pick = selection[name] ?? {};
    const enabled = pick.enabled ?? true;
    // 未探测/非 ready 的主机永远不自启：避免开机就撞一串失败
    const autoStart = Boolean(enabled && pick.autoStart && canAutoStart(probeResults?.[name]));
    hosts[name] = {
      enabled,
      autoStart,
      localPort: hostDefaults.localPort,
      remoteWebPort: hostDefaults.remoteWebPort,
      workdir: hostDefaults.workdir ?? null,
      inject: { env: {}, extraArgs: [], patches: [] },
    };
  }

  return {
    configVersion: 1,
    setupCompleted: true,
    manager: { port: getByPath(answers, 'manager.port') },
    defaults: {
      remoteWebPort: getByPath(answers, 'defaults.remoteWebPort'),
      localPortRange: [...getByPath(answers, 'defaults.localPortRange')],
    },
    hosts,
  };
}

/** 第 4 步预览：2 空格缩进的完整 config JSON。 */
export function previewJson(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}
