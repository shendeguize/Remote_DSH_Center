/**
 * 零依赖手写 schema 校验器（11 §4.3）+ 四份 schema。
 * 组合子风格：每个 schema 是 (value, path, errs) => void，往 errs 推人类可读的错误路径。
 */

import { DshError } from './errors.js';
import { PHASES } from './machine.js';
import { isWorkdirPath, SAFE_HOST_RE } from './shq.js';

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function fail(errs, path, msg) {
  errs.push(`${path || '<root>'}: ${msg}`);
}

export const V = {
  /**
   * @param {Record<string, Function>} shape
   * @param {{extra?:boolean, optional?:string[]}} [opts] extra=false 时未知键报错（config 顶层收紧）
   */
  obj(shape, { extra = false, optional = [] } = {}) {
    const optionalSet = new Set(optional);
    return (value, path, errs) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return fail(errs, path, `expected object, got ${typeName(value)}`);
      }
      for (const [key, schema] of Object.entries(shape)) {
        const child = path ? `${path}.${key}` : key;
        if (!(key in value)) {
          if (!optionalSet.has(key)) fail(errs, child, 'required');
          continue;
        }
        schema(value[key], child, errs);
      }
      if (!extra) {
        for (const key of Object.keys(value)) {
          if (!(key in shape)) fail(errs, path ? `${path}.${key}` : key, 'unknown key');
        }
      }
    };
  },

  str({ pattern, min, max } = {}) {
    return (value, path, errs) => {
      if (typeof value !== 'string') return fail(errs, path, `expected string, got ${typeName(value)}`);
      if (min !== undefined && value.length < min) fail(errs, path, `expected length >= ${min}`);
      if (max !== undefined && value.length > max) fail(errs, path, `expected length <= ${max}`);
      if (pattern && !pattern.test(value)) fail(errs, path, `expected match ${pattern}`);
    };
  },

  int({ min, max } = {}) {
    return (value, path, errs) => {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return fail(errs, path, `expected int, got ${typeName(value)}`);
      }
      if (min !== undefined && value < min) fail(errs, path, `expected int ${min}..${max ?? '∞'}`);
      if (max !== undefined && value > max) fail(errs, path, `expected int ${min ?? '-∞'}..${max}`);
    };
  },

  bool() {
    return (value, path, errs) => {
      if (typeof value !== 'boolean') fail(errs, path, `expected boolean, got ${typeName(value)}`);
    };
  },

  enum_(vals) {
    return (value, path, errs) => {
      if (!vals.includes(value)) fail(errs, path, `expected one of ${vals.join('|')}, got ${JSON.stringify(value)}`);
    };
  },

  arr(item, { max, min } = {}) {
    return (value, path, errs) => {
      if (!Array.isArray(value)) return fail(errs, path, `expected array, got ${typeName(value)}`);
      if (max !== undefined && value.length > max) fail(errs, path, `expected length <= ${max}`);
      if (min !== undefined && value.length < min) fail(errs, path, `expected length >= ${min}`);
      value.forEach((entry, i) => item(entry, `${path}[${i}]`, errs));
    };
  },

  /** Record<string, V>，键需匹配 keyPattern（hosts、inject.env 用）。 */
  rec(keyPattern, valueSchema) {
    return (value, path, errs) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return fail(errs, path, `expected object, got ${typeName(value)}`);
      }
      for (const [key, entry] of Object.entries(value)) {
        const child = path ? `${path}.${key}` : key;
        if (keyPattern && !keyPattern.test(key)) fail(errs, child, `invalid key, expected match ${keyPattern}`);
        valueSchema(entry, child, errs);
      }
    };
  },

  tuple(items) {
    return (value, path, errs) => {
      if (!Array.isArray(value)) return fail(errs, path, `expected array, got ${typeName(value)}`);
      if (value.length !== items.length) fail(errs, path, `expected tuple of ${items.length}`);
      items.forEach((schema, i) => {
        if (i < value.length) schema(value[i], `${path}[${i}]`, errs);
      });
    };
  },

  nullable(inner) {
    return (value, path, errs) => {
      if (value === null) return;
      inner(value, path, errs);
    };
  },

  any() {
    return () => {};
  },

  /** @param {(value:any)=>boolean|string} fn 返回 true 通过；返回 string 作为错误信息 */
  custom(fn, desc = 'custom constraint failed') {
    return (value, path, errs) => {
      const r = fn(value);
      if (r === true) return;
      fail(errs, path, typeof r === 'string' ? r : desc);
    };
  },

  /** 多个 schema 依次施加（用于 tuple + 跨元素约束）。 */
  all(...schemas) {
    return (value, path, errs) => {
      for (const s of schemas) s(value, path, errs);
    };
  },
};

/** @returns {{ok:boolean, errors:string[]}} */
export function validate(schema, value) {
  const errors = [];
  schema(value, '', errors);
  return { ok: errors.length === 0, errors };
}

/** 校验失败即抛 VALIDATION（detail 为逐条错误路径）。 */
export function assertValid(schema, value, summary) {
  const { ok, errors } = validate(schema, value);
  if (!ok) {
    throw new DshError('VALIDATION', summary, { detail: errors.join('\n') });
  }
  return value;
}

// ── 复用片段 ─────────────────────────────────────────────────────────────

const port = V.int({ min: 1, max: 65535 });

/**
 * manager 与本机隧道能真正 bind 的范围。1024 以下要 root，写进去只会在拉起时
 * 撞一个看不懂的失败。`dshc up --port` 也用这一份判据（issue #21）。
 */
export const BINDABLE_PORT_RANGE = { min: 1024, max: 65535 };
export function isBindablePort(v) {
  return Number.isInteger(v) && v >= BINDABLE_PORT_RANGE.min && v <= BINDABLE_PORT_RANGE.max;
}
const bindablePort = V.int(BINDABLE_PORT_RANGE);

const injectSchema = V.obj({
  env: V.rec(ENV_KEY_RE, V.str()),
  extraArgs: V.arr(V.str()),
  patches: V.arr(V.str({ min: 1 })),
});

/** null = 维持现状（远端 $HOME）；非 null 须过 shq 的形态判定（补丁 01 §4.1）。 */
const workdirSchema = V.nullable(V.custom(
  (v) => isWorkdirPath(v) || '须为绝对路径（/ 开头）或 ~、~/… 形态',
));

/**
 * workdir/local 可缺省：configVersion 不升，旧 config 缺字段由 store.migrateConfig
 * 按默认值补齐，故校验层不能因为「没有这个键」就拒绝启动。
 */
const hostConfigSchema = V.obj(
  {
    local: V.bool(),
    enabled: V.bool(),
    autoStart: V.bool(),
    localPort: V.nullable(port),
    remoteWebPort: V.nullable(port),
    workdir: workdirSchema,
    inject: injectSchema,
  },
  { optional: ['local', 'workdir'] },
);

const hostsSchema = V.all(
  V.rec(null, hostConfigSchema),
  (value, path, errs) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    let localCount = 0;
    for (const [name, host] of Object.entries(value)) {
      if (host?.local !== true) continue;
      localCount += 1;
      if (!SAFE_HOST_RE.test(name) || name.startsWith('-')) {
        fail(errs, `${path}.${name}`, `本机主机名须匹配 ${SAFE_HOST_RE} 且不以 - 开头`);
      }
      if (host.localPort !== null) {
        fail(errs, `${path}.${name}.localPort`, '本机主机的 localPort 必须为 null');
      }
    }
    if (localCount > 1) fail(errs, path, '最多只能有一个 local:true 主机');
  },
);

const localPortRangeSchema = V.all(
  V.tuple([bindablePort, bindablePort]),
  V.custom(
    (v) => (Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && Number.isInteger(v[1])
      ? v[0] <= v[1] || 'range start must be <= end'
      : true),
  ),
);

const defaultsSchema = V.obj({
  remoteWebPort: port,
  localPortRange: localPortRangeSchema,
});

// ── 四份 schema（11 §4.3） ──────────────────────────────────────────────

export const configSchema = V.obj({
  configVersion: V.int({ min: 1 }),
  setupCompleted: V.bool(),
  manager: V.obj({ port }),
  defaults: defaultsSchema,
  hosts: hostsSchema,
});

/** state 取宽松模式（extra=true）：12 §4.4 的增补字段允许出现。 */
export const stateSchema = V.obj(
  {
    hosts: V.rec(null, V.obj(
      {
        phase: V.enum_(PHASES),
        probe: V.nullable(V.obj({}, { extra: true })),
        web: V.nullable(V.obj({}, { extra: true })),
        tunnel: V.nullable(V.obj({}, { extra: true })),
        patchSync: V.nullable(V.obj({}, { extra: true })),
        manualInstances: V.arr(V.obj({}, { extra: true })),
      },
      { extra: true, optional: ['probe', 'web', 'tunnel', 'patchSync', 'manualInstances'] },
    )),
  },
  { extra: true },
);

/** 单主机 state 条目（逐条校验丢弃非法项用，11 §4.5）。 */
export const hostStateSchema = V.obj(
  {
    phase: V.enum_(PHASES),
  },
  { extra: true },
);

/** POST /api/setup 请求体 = 整份 config（setupCompleted 由后端强制置 true，故此处可选）。 */
export const setupBodySchema = V.obj(
  {
    configVersion: V.int({ min: 1 }),
    setupCompleted: V.bool(),
    manager: V.obj({ port }),
    defaults: defaultsSchema,
    hosts: hostsSchema,
  },
  { optional: ['configVersion', 'setupCompleted'] },
);

/**
 * PUT /api/hosts/:name/config 局部体：local 可用于回显身份，但 route 层只许它等于现值；
 * localPort 仍由 manager 分配，明令拒收。
 */
export const hostConfigPatchSchema = V.obj(
  {
    local: V.bool(),
    enabled: V.bool(),
    autoStart: V.bool(),
    remoteWebPort: V.nullable(port),
    workdir: workdirSchema,
    inject: injectSchema,
  },
  { optional: ['local', 'enabled', 'autoStart', 'remoteWebPort', 'workdir', 'inject'] },
);

/** POST /api/hosts/local：名称缺省时由 Node 侧注入 os.hostname()。 */
export const localHostCreateSchema = V.obj(
  {
    name: V.all(
      V.str({ min: 1, pattern: SAFE_HOST_RE }),
      V.custom((v) => typeof v !== 'string' || !v.startsWith('-') || '不得以 - 开头'),
    ),
  },
  { optional: ['name'] },
);

/** PUT /api/config/defaults 局部体（13 §2.6）。 */
export const defaultsPatchSchema = V.obj(
  {
    remoteWebPort: port,
    localPortRange: localPortRangeSchema,
    manager: V.obj({ port }),
  },
  { optional: ['remoteWebPort', 'localPortRange', 'manager'] },
);

export { ENV_KEY_RE };
