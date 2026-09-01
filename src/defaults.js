/**
 * 出厂默认表 —— 代码内唯一允许硬编码运行参数的位置（02 §3.0）。
 * 运行期一切参数只认 ~/.dsh_center/config.json；本表仅用于首启预填与 setup 模式兜底。
 */

import os from 'node:os';
import path from 'node:path';

export const CONFIG_VERSION = 1;

export const FACTORY_DEFAULTS = Object.freeze({
  manager: Object.freeze({ port: 7788 }),
  defaults: Object.freeze({
    remoteWebPort: 8899,
    localPortRange: Object.freeze([17701, 17799]),
  }),
  cleanup: Object.freeze({
    rules: Object.freeze(['owned-web', 'test-workdir']),
  }),
  hostDefaults: Object.freeze({
    local: false,
    enabled: true,
    autoStart: false,
    dshPath: null,
    localPort: null,
    remoteWebPort: null,
    // null = 不注入 cd，远端 dsh 以 sshd 给的初始目录（$HOME）启动
    workdir: null,
    // null = 沿用 ~/.ssh/config 里该 Host 的 User；非 null = 覆盖登录用户（多用户远端）
    sshUser: null,
    // null = 按 PATH / 常见目录 / login shell 自动解析；非 null = 每主机显式 dsh 路径
    dshPath: null,
    // null = 用 dsh 的 web profile（默认 `dsh web`）；非 null = 以 `--profile <name>` 启动
    profile: null,
    inject: Object.freeze({
      env: Object.freeze({}),
      extraArgs: Object.freeze([]),
      patches: Object.freeze([]),
    }),
  }),
});

/** 深拷贝一份可写的主机默认配置（FACTORY_DEFAULTS 全冻结，不能直接塞进草稿）。 */
export function newHostConfig() {
  return {
    local: FACTORY_DEFAULTS.hostDefaults.local,
    enabled: FACTORY_DEFAULTS.hostDefaults.enabled,
    autoStart: FACTORY_DEFAULTS.hostDefaults.autoStart,
    dshPath: FACTORY_DEFAULTS.hostDefaults.dshPath,
    localPort: FACTORY_DEFAULTS.hostDefaults.localPort,
    remoteWebPort: FACTORY_DEFAULTS.hostDefaults.remoteWebPort,
    workdir: FACTORY_DEFAULTS.hostDefaults.workdir,
    sshUser: FACTORY_DEFAULTS.hostDefaults.sshUser,
    dshPath: FACTORY_DEFAULTS.hostDefaults.dshPath,
    profile: FACTORY_DEFAULTS.hostDefaults.profile,
    inject: { env: {}, extraArgs: [], patches: [] },
  };
}

/** 出厂 config 骨架（setup 未完成状态）。 */
export function newFactoryConfig() {
  return {
    configVersion: CONFIG_VERSION,
    setupCompleted: false,
    manager: { port: FACTORY_DEFAULTS.manager.port },
    defaults: {
      remoteWebPort: FACTORY_DEFAULTS.defaults.remoteWebPort,
      localPortRange: [...FACTORY_DEFAULTS.defaults.localPortRange],
    },
    cleanup: { rules: [...FACTORY_DEFAULTS.cleanup.rules] },
    hosts: {},
  };
}

/**
 * 全部持久化路径。DSHC_HOME 环境变量可整体重定向（集成测试隔离用，见 14 §2）。
 */
export function resolvePaths(env = process.env, homedir = os.homedir()) {
  const dir = env.DSHC_HOME ? path.resolve(env.DSHC_HOME) : path.join(homedir, '.dsh_center');
  return Object.freeze({
    dir,
    config: path.join(dir, 'config.json'),
    state: path.join(dir, 'state.json'),
    pidfile: path.join(dir, 'manager.pid'),
    log: path.join(dir, 'manager.log'),
    plist: path.join(homedir, 'Library', 'LaunchAgents', 'com.dsh-center.manager.plist'),
  });
}

export const PATHS = resolvePaths();

export const LAUNCHD_LABEL = 'com.dsh-center.manager';

/** 远端落地目录（03 §1），相对远端 $HOME。 */
export const REMOTE_DIR = '.dsh_center_remote';

/**
 * 「对每台各来一次 ssh」这类扇出的同时在飞上限（issue #85）。
 *
 * 取 6 是照着 sshd 的出厂 `MaxStartups 10:30:100` 来的：未完成认证的连接过 10 条就开始
 * 被随机丢，而多台远端共用一台跳板机时这个额度是合起来算的。留 4 条余量给用户自己的
 * ssh 会话与隧道重连。这不是用户可调项，故只在出厂表里，不进 config schema。
 */
export const SSH_FANOUT_LIMIT = 6;
