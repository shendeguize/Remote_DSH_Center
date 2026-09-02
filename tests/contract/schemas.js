/**
 * 13_api_schema.md 的可执行版本（TST-05）。
 *
 * 全部对象都用 extra=false（未知顶层键即失败）——契约漂移在测试里立刻变红，
 * 而不是等前端在浏览器里发现字段没了。集成测试对**每一个**收到的响应与 SSE 帧
 * 都过一次这里的校验器。
 */

import assert from 'node:assert/strict';

import { SYNC_PROFILE_FIELDS } from '../../src/config-sync.js';
import { V, validate } from '../../src/lib/validate.js';
import { PHASES } from '../../src/lib/machine.js';
import { ERROR_HTTP_STATUS } from '../../src/lib/errors.js';
import { posixCksum, SETTINGS_MAX_BYTES } from '../../src/settings-file.js';

const port = V.int({ min: 1, max: 65535 });
const iso = V.str({ pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/ });
const revision = V.int({ min: 0 });
const ERROR_CODES = Object.keys(ERROR_HTTP_STATUS);

// ── §1 公共类型 ─────────────────────────────────────────────────────────

export const errorBody = V.obj(
  { error: V.str({ min: 1 }), code: V.enum_(ERROR_CODES), detail: V.str() },
  { optional: ['detail'] },
);

export const accepted = V.obj({
  accepted: V.custom((v) => v === true, 'expected true'),
  operationId: V.str({ pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ }),
  host: V.nullable(V.str({ min: 1 })),
});

const injectView = V.obj({
  env: V.rec(/^[A-Za-z_][A-Za-z0-9_]*$/, V.str()),
  extraArgs: V.arr(V.str()),
  patches: V.arr(V.str({ min: 1 })),
});

const workdirView = V.nullable(V.str({ pattern: /^(?:\/|~$|~\/)/ }));

const hostConfigView = V.obj({
  local: V.bool(),
  enabled: V.bool(),
  autoStart: V.bool(),
  dshPath: V.nullable(V.str()),
  localPort: V.nullable(port),
  remoteWebPort: V.nullable(port),
  workdir: workdirView,
  inject: injectView,
}, { optional: ['dshPath'] });

export const hostView = V.obj({
  name: V.str({ min: 1 }),
  local: V.bool(),
  sshInfo: V.nullable(V.obj({
    hostName: V.nullable(V.str()),
    user: V.nullable(V.str()),
    port: V.nullable(port),
  })),
  orphaned: V.bool(),
  // 名单挡下的主机：留在 config 里但退出一切自动化，判定原因随视图一起给出
  blocked: V.nullable(V.obj({
    rule: V.enum_(['allow', 'deny']),
    pattern: V.str({ min: 1 }),
    reason: V.str({ min: 1 }),
  })),
  config: hostConfigView,
  phase: V.enum_(PHASES),
  effectiveRemotePort: port,
  mappedUrl: V.nullable(V.str({ pattern: /^http:\/\/127\.0\.0\.1:\d+\/$/ })),
  probe: V.nullable(V.obj({
    dshPath: V.nullable(V.str()),
    version: V.nullable(V.str()),
    dshHome: V.nullable(V.str()),
    profileWeb: V.bool(),
    dependencies: V.obj({
      binary: V.bool(),
      webProfile: V.bool(),
      bash: V.bool(),
      timeout: V.bool(),
    }),
    noDshReason: V.nullable(V.enum_(['missing-bin', 'no-web-profile'])),
    sniff: V.obj({
      paths: V.arr(V.str()),
      loginPath: V.nullable(V.str()),
      version: V.nullable(V.str()),
      probePath: V.nullable(V.str()),
    }),
    at: iso,
    errorSummary: V.nullable(V.str()),
  }, { optional: ['dependencies', 'sniff'] })),
  web: V.nullable(V.obj({
    pid: V.int({ min: 1 }),
    port,
    startedByUs: V.bool(),
    cmdFingerprint: V.str({ min: 1 }),
    // 领养来的实例日志不归我们管（launcher.adopt 记 null），只有自己拉起的才有日志名
    log: V.nullable(V.str({ min: 1 })),
    startedAt: iso,
    // 本次实例实际生效的启动目录（与 config.workdir 不等 = 重启后生效）
    workdir: workdirView,
    // 远端实测工作目录（best-effort，/proc 不可读时为 null）；仅展示，不作 kill 判据
    cwd: V.nullable(V.str({ min: 1 })),
  })),
  tunnel: V.nullable(V.obj({
    localPort: V.nullable(port),
    connected: V.bool(),
    reconnectAttempt: V.int({ min: 0 }),
    suspendedReason: V.nullable(V.enum_(['forward-disabled', 'local-port-busy'])),
  })),
  patchSync: V.obj({
    files: V.rec(null, V.obj({
      hash: V.str({ min: 1 }),
      remoteName: V.str({ min: 1 }),
      syncedAt: V.nullable(iso),
    })),
  }),
  manualInstances: V.arr(V.obj(
    { pid: V.int({ min: 1 }), args: V.str(), port: V.nullable(port) },
    { optional: ['port'] },
  )),
});

// ── §2 REST ─────────────────────────────────────────────────────────────

export const hostsList = V.obj({ revision, hosts: V.arr(hostView) });

const absolutePosixPath = V.all(
  V.str({ min: 1 }),
  V.custom(
    (value) => typeof value !== 'string'
      || (value.startsWith('/') && !value.includes('\0'))
      || 'expected absolute POSIX path',
  ),
);

export const workspaceRegisterResponse = V.obj({
  created: V.bool(),
  workspaceId: V.str({ min: 1 }),
  title: V.str(),
  path: absolutePosixPath,
});

const hostFilterView = V.obj({
  allow: V.arr(V.str({ min: 1 })),
  deny: V.arr(V.str({ min: 1 })),
});

const defaultsView = V.obj({
  remoteWebPort: port,
  localPortRange: V.tuple([V.int({ min: 1024, max: 65535 }), V.int({ min: 1024, max: 65535 })]),
  hostFilter: hostFilterView,
});

export const configBody = V.obj({
  configVersion: V.int({ min: 1 }),
  setupCompleted: V.bool(),
  manager: V.obj({ port }),
  defaults: defaultsView,
  cleanup: V.obj({
    rules: V.arr(V.str({ min: 1, max: 32 })),
  }),
  hosts: V.rec(null, hostConfigView),
}, { optional: ['cleanup'] });

export const managerInfo = V.obj({
  version: V.str({ min: 1 }),
  pid: V.int({ min: 1 }),
  port,
  mode: V.enum_(['foreground', 'background', 'launchd']),
  startedAt: iso,
  uptimeMs: V.int({ min: 0 }),
  setupCompleted: V.bool(),
  setupGateActive: V.bool(),
  hostCounts: V.obj({
    total: V.int({ min: 0 }),
    running: V.int({ min: 0 }),
    degraded: V.int({ min: 0 }),
    crashed: V.int({ min: 0 }),
  }),
  revision,
});

export const hostConfigPutResponse = V.obj({ host: hostView });
export const localHostCreateResponse = V.obj({ host: hostView });

const SETTINGS_CHECKSUM_RE = /^cksum-v1:(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,6})$/u;

function parseSettingsChecksum(value) {
  if (typeof value !== 'string') return null;
  const match = SETTINGS_CHECKSUM_RE.exec(value);
  if (
    !match
    || Number(match[1]) > 0xffff_ffff
    || Number(match[2]) > SETTINGS_MAX_BYTES
  ) {
    return null;
  }
  return { crc: Number(match[1]), size: Number(match[2]) };
}

const settingsPath = V.all(
  V.str({ min: 1 }),
  V.custom(
    (value) => typeof value !== 'string'
      || (value.startsWith('/') && value.endsWith('/settings.yaml'))
      || 'expected absolute settings.yaml path',
  ),
);
const settingsChecksum = V.custom(
  (value) => parseSettingsChecksum(value) !== null || 'expected valid cksum-v1 token',
);
const settingsSize = V.int({ min: 0, max: SETTINGS_MAX_BYTES });

export const settingsReadResponse = V.all(
  V.obj({
    exists: V.bool(),
    path: settingsPath,
    content: V.str(),
    checksum: V.nullable(settingsChecksum),
    size: settingsSize,
  }),
  V.custom((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return true;
    if (value.exists === false) {
      return (
        value.checksum === null
        && value.content === ''
        && value.size === 0
      ) || 'exists=false requires checksum=null, content="" and size=0';
    }
    if (value.exists !== true) return true;
    const token = parseSettingsChecksum(value.checksum);
    if (!token || token.size !== value.size) {
      return 'exists=true requires checksum byte count to match size';
    }
    if (typeof value.content !== 'string') return true;
    const bytes = Buffer.from(value.content, 'utf8');
    if (bytes.byteLength !== value.size) {
      return 'exists=true requires UTF-8 content byte count to match size';
    }
    return token.crc === posixCksum(bytes)
      || 'exists=true requires checksum CRC to match content';
  }),
);

export const settingsWriteResponse = V.all(
  V.obj({
    updated: V.custom((value) => value === true, 'expected true'),
    path: settingsPath,
    checksum: settingsChecksum,
    size: settingsSize,
  }),
  V.custom((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return true;
    const token = parseSettingsChecksum(value.checksum);
    return !token
      || token.size === value.size
      || 'checksum byte count must match size';
  }),
);

const syncConfigTarget = V.obj({
  name: V.str({ min: 1 }),
  changed: V.bool(),
  changedFields: V.arr(V.enum_(SYNC_PROFILE_FIELDS)),
});

const syncConfigPreviewResponse = V.obj({
  source: V.str({ min: 1 }),
  dryRun: V.custom((value) => value === true, 'expected true'),
  previewToken: V.str({ min: 1 }),
  targets: V.arr(syncConfigTarget, { min: 1, max: 200 }),
  applied: V.arr(V.str({ min: 1 }), { max: 0 }),
  hosts: V.arr(hostView, { max: 0 }),
});

const syncConfigApplyResponse = V.obj({
  source: V.str({ min: 1 }),
  dryRun: V.custom((value) => value === false, 'expected false'),
  targets: V.arr(syncConfigTarget, { min: 1, max: 200 }),
  applied: V.arr(V.str({ min: 1 })),
  hosts: V.arr(hostView),
});

/**
 * `dryRun` 是响应判别字段：preview 签发 token 且不应用任何主机，apply 则不回传 token。
 * 非法/缺失判别字段先走最小对象校验，避免错误值被误分到任一合法分支。
 */
export const syncConfigResponse = (value, path, errs) => {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (value.dryRun === true) return syncConfigPreviewResponse(value, path, errs);
    if (value.dryRun === false) return syncConfigApplyResponse(value, path, errs);
  }
  return V.obj({ dryRun: V.bool() }, { extra: true })(value, path, errs);
};

export const defaultsPutResponse = V.obj({
  defaults: defaultsView,
  manager: V.obj({ port }),
  restartRequired: V.bool(),
});

export const reloadResponse = V.obj({
  changed: V.arr(V.str()),
  orphaned: V.arr(V.str({ min: 1 })),
  // 本轮被名单挡下、因此没有纳管的 ssh config 条目（静默过滤是陷阱，得报出来）
  filtered: V.arr(V.str({ min: 1 })),
});
export const orphanedClearResponse = V.obj({
  removed: V.arr(V.str({ min: 1 })),
});
export const blockedClearResponse = V.obj({
  removed: V.arr(V.str({ min: 1 })),
  // 还有实例在跑的不动它：名单是发现规则，不是关停命令
  skipped: V.arr(V.str({ min: 1 })),
});

export const setupResponse = V.obj({
  ok: V.bool(),
  port,
  portChanged: V.bool(),
  restartRequired: V.bool(),
  restarting: V.bool(),
});

export const managerActionResponse = V.obj({
  accepted: V.custom((v) => v === true, 'expected true'),
  mode: V.enum_(['foreground', 'background', 'launchd']),
});

// ── §3 SSE ──────────────────────────────────────────────────────────────

export const logLine = V.obj({
  revision,
  host: V.nullable(V.str({ min: 1 })),
  level: V.enum_(['info', 'warn', 'error']),
  msg: V.str(),
  ts: iso,
  detail: V.nullable(V.str()),
});

export const snapshot = V.obj({
  revision,
  manager: managerInfo,
  configuredPort: V.nullable(port),
  defaults: V.nullable(defaultsView),
  hosts: V.arr(hostView),
  logs: V.arr(V.obj({
    host: V.nullable(V.str({ min: 1 })),
    level: V.enum_(['info', 'warn', 'error']),
    msg: V.str(),
    ts: iso,
    detail: V.nullable(V.str()),
  })),
});

export const hostChanged = V.obj({ revision, host: hostView });

export const operationDone = V.obj({
  revision,
  operationId: V.str({ min: 1 }),
  host: V.nullable(V.str({ min: 1 })),
  action: V.enum_(['start', 'stop', 'restart', 'reconnect', 'probe', 'probe-all', 'adopt']),
  status: V.enum_(['ok', 'failed']),
  error: V.nullable(V.str()),
  code: V.nullable(V.enum_(ERROR_CODES)),
  detail: V.nullable(V.str()),
});

export const configChanged = V.obj({
  revision,
  defaults: V.nullable(defaultsView),
  manager: V.nullable(V.obj({ port })),
  changed: V.arr(V.str()),
});

/** SSE type → 校验器（集成测试遍历收到的所有帧）。 */
export const SSE_SCHEMAS = {
  snapshot,
  'host-changed': hostChanged,
  'operation-done': operationDone,
  'log-line': logLine,
  'config-changed': configChanged,
};

// ── 断言助手 ────────────────────────────────────────────────────────────

export function assertShape(schema, value, label) {
  const { ok, errors } = validate(schema, value);
  assert.ok(ok, `${label} 不符契约：\n${errors.join('\n')}\n实际值：${JSON.stringify(value, null, 2)}`);
  return value;
}

/** 断言一条 REST 响应（状态码 + 体形状；非 2xx 一律走 §1.1 错误体）。 */
export function assertRest(res, { status, schema, label }) {
  assert.equal(res.status, status, `${label} 状态码：${res.status}，体 ${res.text}`);
  if (status >= 400) return assertShape(errorBody, res.json, `${label} 错误体`);
  return assertShape(schema, res.json, label);
}

/** 断言 SSE 连接收到的每一帧（含 revision 单调，snapshot 除外，13 §5.4）。 */
export function assertSseStream(frames, { label = 'SSE' } = {}) {
  let last = -1;
  for (const [i, frame] of frames.entries()) {
    const schema = SSE_SCHEMAS[frame.type];
    assert.ok(schema, `${label} 第 ${i} 帧类型未定义于契约：${frame.type}`);
    assertShape(schema, frame.data, `${label} 第 ${i} 帧（${frame.type}）`);
    if (frame.type !== 'snapshot') {
      assert.ok(frame.data.revision > last, `${label} revision 未单调递增：${frame.data.revision} <= ${last}`);
    }
    last = frame.data.revision;
  }
  return frames;
}

/** 13 §5.5：mappedUrl 与 tunnel.localPort、phase 的一致性。 */
export function assertMappedUrlConsistency(host) {
  if (host.mappedUrl === null) return;
  assert.ok(['running', 'degraded'].includes(host.phase), `mappedUrl 非 null 但 phase=${host.phase}`);
  assert.equal(host.mappedUrl, `http://127.0.0.1:${host.tunnel?.localPort}/`);
}
