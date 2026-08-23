/**
 * 表单校验与解析（10 §3.7 / UI-19、UI-23）。
 *
 * 纯函数区（本文件上半）与后端 src/lib/validate.js 的约束保持双层一致：
 * 前端只做即时提示，落盘对错以后端 400 VALIDATION 为准。
 */

import { BINDABLE_PORT_MIN, PORT_MAX, PORT_MIN } from './setup-schema.js';

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parsePort(raw, {
  field = 'port', allowEmpty = false, min = PORT_MIN, max = PORT_MAX,
} = {}) {
  const s = String(raw ?? '').trim();
  if (s === '') {
    if (allowEmpty) return { ok: true, value: null };
    return { ok: false, error: `${field} 不能为空` };
  }
  if (!/^\d+$/.test(s)) return { ok: false, error: `${field} 必须是整数` };
  const n = Number(s);
  if (n < min || n > max) return { ok: false, error: `${field} 须在 ${min}–${max} 之间` };
  return { ok: true, value: n };
}

/** 本机端口区间：需成对、有序，且宽度足够容纳预期主机数。 */
export function parsePortRange(rawFrom, rawTo, { minWidth = 1 } = {}) {
  const from = parsePort(rawFrom, { field: '区间起点', min: BINDABLE_PORT_MIN });
  if (!from.ok) return from;
  const to = parsePort(rawTo, { field: '区间终点', min: BINDABLE_PORT_MIN });
  if (!to.ok) return to;
  if (to.value < from.value) return { ok: false, error: '区间终点必须 ≥ 起点' };
  const width = to.value - from.value + 1;
  if (width < minWidth) return { ok: false, error: `区间至少需要 ${minWidth} 个端口，当前 ${width}` };
  return { ok: true, value: [from.value, to.value] };
}

/**
 * `KEY=VALUE` 多行文本 → 对象。值可含 `=`，只切第一个。
 * @returns {{ok:true,value:Record<string,string>}|{ok:false,error:string}}
 */
export function parseEnvLines(textValue) {
  const out = {};
  const lines = String(textValue ?? '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return { ok: false, error: `第 ${i + 1} 行不是 KEY=VALUE 形式` };
    const key = line.slice(0, eq).trim();
    if (!ENV_KEY_RE.test(key)) return { ok: false, error: `第 ${i + 1} 行键名 "${key}" 非法（须匹配 ^[A-Za-z_][A-Za-z0-9_]*$）` };
    if (key in out) return { ok: false, error: `第 ${i + 1} 行键名 "${key}" 重复` };
    out[key] = line.slice(eq + 1).trim();
  }
  return { ok: true, value: out };
}

export function formatEnvLines(env) {
  return Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
}

/** 每行一项的列表（extraArgs / patches）。空行忽略，保持顺序。 */
export function parseLines(textValue) {
  return String(textValue ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

export function formatLines(list) {
  return (list ?? []).join('\n');
}

/** 与后端 shq.isWorkdirPath 双层一致：只认绝对路径与 `~` 前缀。 */
export const WORKDIR_RE = /^(?:\/|~$|~\/)/;

/**
 * 远端启动目录。留空 = null = 维持现状（远端家目录）。
 * @returns {{ok:true,value:string|null}|{ok:false,error:string}}
 */
export function parseWorkdir(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { ok: true, value: null };
  if (!WORKDIR_RE.test(s)) {
    return { ok: false, error: '须是绝对路径（/ 开头）或 ~、~/… 形态；相对路径无从解释' };
  }
  return { ok: true, value: s };
}

/** patches 必须是绝对路径（本机文件才可能被 scp 上去）。 */
export function validatePatches(list) {
  for (const p of list) {
    if (!p.startsWith('/')) return { ok: false, error: `patch 路径必须是绝对路径：${p}` };
  }
  return { ok: true, value: list };
}

/**
 * 主机注入表单 → PUT /api/hosts/:name/config 请求体。
 * @param {{enabled:boolean, remoteWebPort:string, workdir:string,
 *          env:string, extraArgs:string, patches:string}} raw
 */
export function buildHostPatch(raw) {
  const errors = {};
  const port = parsePort(raw.remoteWebPort, { field: '远端端口', allowEmpty: true });
  if (!port.ok) errors.remoteWebPort = port.error;

  const workdir = parseWorkdir(raw.workdir);
  if (!workdir.ok) errors.workdir = workdir.error;

  const env = parseEnvLines(raw.env);
  if (!env.ok) errors.env = env.error;

  const patches = validatePatches(parseLines(raw.patches));
  if (!patches.ok) errors.patches = patches.error;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      enabled: Boolean(raw.enabled),
      remoteWebPort: port.value,
      workdir: workdir.value,
      inject: { env: env.value, extraArgs: parseLines(raw.extraArgs), patches: patches.value },
    },
  };
}

/** 全局默认表单 → PUT /api/config/defaults 请求体。 */
export function buildDefaultsPatch(raw, { minWidth = 1 } = {}) {
  const errors = {};
  const remote = parsePort(raw.remoteWebPort, { field: '远端默认端口' });
  if (!remote.ok) errors.remoteWebPort = remote.error;

  const range = parsePortRange(raw.rangeFrom, raw.rangeTo, { minWidth });
  if (!range.ok) errors.localPortRange = range.error;

  const managerPort = parsePort(raw.managerPort, { field: 'manager 端口' });
  if (!managerPort.ok) errors.managerPort = managerPort.error;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      remoteWebPort: remote.value,
      localPortRange: range.value,
      manager: { port: managerPort.value },
    },
  };
}

/** 只提交真正改动的键，避免把未触碰的字段“全量替换”成当前显示值。 */
export function diffPatch(patch, current) {
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!deepEqual(value, current?.[key])) out[key] = value;
  }
  return out;
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

// ── DOM 助手（调用时才碰 document） ─────────────────────────────────────

/**
 * 带 label / 错误位的字段行。
 * @returns {{root:HTMLElement, input:HTMLElement, setError:(msg:string|null)=>void}}
 */
export function field(label, input, { hint = null } = {}) {
  const id = input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  const err = document.createElement('p');
  err.className = 'field-error';
  err.hidden = true;
  const root = document.createElement('div');
  root.className = 'field';
  const lab = document.createElement('label');
  lab.setAttribute('for', id);
  lab.textContent = label;
  root.append(lab, input);
  if (hint) {
    const h = document.createElement('p');
    h.className = 'field-hint';
    h.textContent = hint;
    root.append(h);
  }
  root.append(err);
  return {
    root,
    input,
    setError(msg) {
      err.textContent = msg ?? '';
      err.hidden = !msg;
      root.classList.toggle('has-error', Boolean(msg));
      input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    },
  };
}

export function input(type, value, props = {}) {
  const node = document.createElement(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') node.type = type;
  if (type === 'checkbox') node.checked = Boolean(value);
  else node.value = value === null || value === undefined ? '' : String(value);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (k === 'on') for (const [evt, fn] of Object.entries(v)) node.addEventListener(evt, fn);
    else node.setAttribute(k, String(v));
  }
  return node;
}
