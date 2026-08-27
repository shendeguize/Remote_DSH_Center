/**
 * 故障注入场景库（14 §1.4）。每个场景是一个 host state 补丁，可独立激活。
 * 场景名与覆盖矩阵（tests/COVERAGE_MATRIX.md）的行一一对应。
 */

import { host as hostState, mutate, newHostState } from './state.js';

export const SCENARIOS = {
  /** 健康的 ready 主机（基线）。 */
  healthy: () => newHostState(),

  /** settings.yaml 缺失（正常初始态）。 */
  'settings-missing': () => newHostState(),

  /** 普通 UTF-8 settings.yaml；内容只用合成测试值。 */
  'settings-existing': (content = 'provider: synthetic\nkey: test-only\n') => newHostState({
    settingsHex: Buffer.from(content).toString('hex'),
    settingsMode: 0o600,
  }),

  /** 存在但为零字节的 settings.yaml。 */
  'settings-empty': () => newHostState({
    settingsHex: '',
    settingsMode: 0o600,
  }),

  /** 非法 UTF-8：截断/错误 continuation 组合。 */
  'settings-invalid-utf8': () => newHostState({
    settingsHex: Buffer.from([0xc3, 0x28]).toString('hex'),
    settingsMode: 0o600,
  }),

  /** 精确 512 KiB 的合法读取边界。 */
  'settings-exact-cap': () => newHostState({
    settingsHex: Buffer.alloc(512 * 1024, 0x78).toString('hex'),
    settingsMode: 0o600,
  }),

  /** 512 KiB + 1，READ 必须以 settings-too-large 快败。 */
  'settings-too-large': () => newHostState({
    settingsHex: Buffer.alloc(512 * 1024 + 1, 0x78).toString('hex'),
    settingsMode: 0o600,
  }),

  /** POSIX 工具/方言能力不满足，只禁用 settings 编辑。 */
  'settings-unsupported': () => newHostState({
    faults: { settingsUnsupported: true },
  }),

  /** 目标类型/权限等普通读取故障。 */
  'settings-read-fail': () => newHostState({
    faults: { settingsReadFail: true },
  }),

  /** 成功形状内故意回放错误 CRC，覆盖安全 PROTO_PARSE。 */
  'settings-protocol-corrupt': () => newHostState({
    settingsHex: Buffer.from('protocol-corrupt: synthetic\n').toString('hex'),
    settingsMode: 0o600,
    faults: { settingsProtocolCorrupt: true },
  }),

  /** 提交点前写失败，正式目标与备份都不动。 */
  'settings-write-fail': () => newHostState({
    faults: { settingsWriteFail: true },
  }),

  /** staging 已接收后灾难中断；允许遗留，下一次 settings 操作必须清理。 */
  'settings-staging-catastrophic': () => newHostState({
    faults: { settingsCatastrophicAfterStaging: true },
  }),

  /** 备份已发布、尚未提交时结果无法确认；正式目标仍保持 base。 */
  'settings-write-unknown-before-commit': (
    content = 'unknown-before-base: synthetic\n',
  ) => newHostState({
    settingsHex: Buffer.from(content).toString('hex'),
    settingsMode: 0o600,
    faults: { settingsWriteUnknownBeforeCommit: true },
  }),

  /** 模拟已提交但无法确认响应，调用方必须重新 GET。 */
  'settings-write-unknown-after-commit': (
    content = 'unknown-after-base: synthetic\n',
  ) => newHostState({
    settingsHex: Buffer.from(content).toString('hex'),
    settingsMode: 0o600,
    faults: { settingsWriteUnknown: true },
  }),

  /** 兼容旧场景名：同 unknown-after-commit。 */
  'settings-write-unknown': () => newHostState({
    faults: { settingsWriteUnknown: true },
  }),

  /** 第一次 CAS 后由外部编辑器改写，第二次 CAS 必须拒绝覆盖。 */
  'settings-change-before-second-cas': (
    content = 'second-cas-base: synthetic\n',
    external = 'second-cas-external: synthetic\n',
  ) => newHostState({
    settingsHex: Buffer.from(content).toString('hex'),
    settingsMode: 0o600,
    faults: { settingsChangeBeforeSecondCas: external },
  }),

  /** dsh 未安装 → no_dsh(missing-bin)。 */
  'no-dsh-missing-bin': () => newHostState({ dshInstalled: false }),

  /** dsh 只在非常规 login PATH 中 → no_dsh，但嗅探应发现它。 */
  'no-dsh-unusual-path': () => newHostState({
    dshInstalled: false,
    dshSniffPaths: ['/root/.canon/node/bin/dsh'],
    dshLoginPath: '/root/.canon/node/bin/dsh',
    dshSniffVersion: 'dsh 0.1.1-rc.2',
  }),

  /** dsh 在但 web profile 未配置 → no_dsh(no-web-profile)。 */
  'no-dsh-no-profile': () => newHostState({ profileWeb: false }),

  /** ssh 连不上 → unreachable。 */
  unreachable: () => newHostState({ reachable: false }),

  /** Host key 校验失败 → unreachable 细分文案。 */
  'hostkey-fail': () => newHostState({ faults: { hostkeyFail: true } }),

  /** ssh 挂住 → sshExec 强杀链 + unreachable。 */
  'conn-timeout': (ms = 30_000) => newHostState({ faults: { connTimeoutMs: ms } }),

  /** 首次 LAUNCH 端口被占 → 降级 --port 0 全路径（12 §3 S2→S4→S3）。 */
  'bind-busy-once': () => newHostState({ faults: { bindBusyTimes: 1 } }),

  /** 两次均被占（含降级的 --port 0）→ 双失败回滚 + 双日志尾（S5）。 */
  'bind-busy-twice': () => newHostState({ faults: { bindBusyTimes: 5 } }),

  /** 进程启动即崩 → S2 的 ALIVE=no 快败路径。 */
  'launch-dies': () => newHostState({ faults: { failStartTimes: 5 } }),

  /** 启动目录不存在/不可进入 → cd 失败，ERR=workdir + 退出码 8（补丁 01 §4.1）。 */
  'workdir-missing': () => newHostState({ faults: { badWorkdir: true } }),

  /** 远端 AllowTcpForwarding=no → tunnel 挂起分类，不无限重连。 */
  'forward-disabled': () => newHostState({ faults: { forwardDisabled: true } }),

  /** 无 ss 命令 → LISTEN=unknown 不作否定证据。 */
  'no-ss': () => newHostState({ faults: { noSs: true } }),

  /** /proc/<pid>/cwd 不可读（非 Linux/受限容器）→ CWD=unknown，纯展示字段降级。 */
  'no-proc-cwd': () => newHostState({ faults: { noProcCwd: true } }),

  /** scp 失败 → patch 同步整体快败。 */
  'scp-fail': () => newHostState({ faults: { scpFail: true } }),

  /** 探测慢 → 向导渐进探测、probe-all 并行不阻塞。 */
  'slow-probe': (ms = 800) => newHostState({ faults: { slowProbeMs: ms } }),
};

/** 把场景写入某台假主机。 */
export function applyScenario(name, scenario, ...args) {
  const factory = SCENARIOS[scenario];
  if (!factory) throw new Error(`未知场景：${scenario}`);
  const patch = factory(...args);
  return mutate((state) => {
    state.hosts ??= {};
    state.hosts[name] = { ...patch };
    return state.hosts[name];
  });
}

/** 运行期故障：把已登记的进程标记为已死（remote-crash）。 */
export function crashRemote(name) {
  return mutate((state) => {
    const h = hostState(state, name);
    for (const [pid, p] of Object.entries(h.processes)) {
      if (p.dead) continue;
      p.dead = true;
      try { process.kill(Number(pid), 'SIGKILL'); } catch { /* 已经没了 */ }
    }
  });
}

/** 运行期故障：同 pid 换 args → 指纹全等拒杀（KILL_REFUSED，pid-reuse）。 */
export function reusePid(name, newArgs = 'dsh web --no-open --host 127.0.0.1 --port 9999') {
  return mutate((state) => {
    const h = hostState(state, name);
    for (const p of Object.values(h.processes)) {
      if (!p.dead) p.args = newArgs;
    }
  });
}

/** 运行期故障：给假主机追加/修改故障位。 */
export function setFaults(name, faults) {
  return mutate((state) => {
    const h = hostState(state, name);
    h.faults = { ...h.faults, ...faults };
    return h.faults;
  });
}
