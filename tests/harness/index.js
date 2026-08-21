/**
 * 假远端装置的装配入口（14 §1、§2）。
 *
 * 一次 createHarness() 给出：隔离的 DSHC_HOME、假 ssh config、假 ssh/scp 垫片环境变量、
 * 以及操作假远端状态引擎的助手。
 *
 * 关于垫片注入方式的实现级决策：14 §1.1 原案是把 tests/harness/bin 前置到 PATH。
 * 本机实测发现——经 shebang 脚本启动的子进程收不到 spawn 侧发出的 SIGTERM/SIGKILL
 * （见 tests/harness/bin/README.md），会让 sshExec 的强杀链与 tunnel 的 kill 无法验证。
 * 故改用 lib/ssh 既有的 DSHC_SSH_BIN / DSHC_SCP_BIN 注入点，令 node 成为直接子进程。
 * bin/ 下的 PATH 垫片仍保留，供手工排查使用。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { newHostState, readState, writeState, mutate, host as hostState } from './state.js';
import { applyScenario, crashRemote, reusePid, setFaults } from './scenarios.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_SSH = path.join(HERE, 'fake-ssh.js');
export const FAKE_SCP = path.join(HERE, 'fake-scp.js');
export const FAKE_OPEN = path.join(HERE, 'fake-open.js');
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/**
 * @param {{hosts?: Record<string, object>, sshConfig?: string, config?: object}} [opts]
 */
export function createHarness(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-harness-'));
  const harnessDir = path.join(root, 'harness');
  const homeDir = path.join(root, 'dsh_center');
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });

  const hosts = opts.hosts ?? { 'gpu-1': newHostState() };
  writeState({ hosts }, harnessDir);

  const sshConfigPath = path.join(root, 'ssh_config');
  fs.writeFileSync(
    sshConfigPath,
    opts.sshConfig
      ?? Object.keys(hosts)
        .map((n, i) => `Host ${n}\n  HostName 10.0.0.${i + 1}\n  User root\n  Port 22\n`)
        .join('\n'),
  );

  if (opts.config) {
    fs.writeFileSync(path.join(homeDir, 'config.json'), `${JSON.stringify(opts.config, null, 2)}\n`);
  }

  const env = {
    DSHC_HOME: homeDir,
    DSHC_HARNESS_DIR: harnessDir,
    DSHC_SSH_CONFIG: sshConfigPath,
    // 假 dsh web 是 detached 起的（要活过 ssh 命令），运行被打断时没人收它。
    // 下发「拥有者」pid，垫片据此自查：造它的那次运行没了就自己退。
    DSHC_HARNESS_OWNER_PID: String(process.pid),
    DSHC_SSH_BIN: `${process.execPath} ${FAKE_SSH}`,
    DSHC_SCP_BIN: `${process.execPath} ${FAKE_SCP}`,
    // 拦住浏览器：跑用例不该弹窗，而「有没有去开」本身是 dshc open 的核心行为
    DSHC_OPEN_BIN: `${process.execPath} ${FAKE_OPEN}`,
  };

  return {
    root,
    harnessDir,
    homeDir,
    sshConfigPath,
    env,

    /** 把 env 装进当前进程（进程内测试用）；返回还原函数。 */
    activate() {
      const saved = {};
      for (const [k, v] of Object.entries(env)) {
        saved[k] = process.env[k];
        process.env[k] = v;
      }
      return () => {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      };
    },

    /** 假 open 的账本：每次被调用记一行 URL。 */
    openedUrls() {
      try {
        return fs.readFileSync(path.join(harnessDir, 'open.log'), 'utf8').trim().split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },

    state: () => readState(harnessDir),
    hostState: (name) => readState(harnessDir).hosts?.[name] ?? null,
    setHost(name, patch) {
      return mutate((s) => {
        s.hosts ??= {};
        s.hosts[name] = { ...newHostState(), ...patch };
        return s.hosts[name];
      }, harnessDir);
    },
    scenario: (name, scenario, ...args) => withDir(harnessDir, () => applyScenario(name, scenario, ...args)),
    crash: (name) => withDir(harnessDir, () => crashRemote(name)),
    reusePid: (name, args) => withDir(harnessDir, () => reusePid(name, args)),
    faults: (name, f) => withDir(harnessDir, () => setFaults(name, f)),

    /** 远端存活进程清单（集成测试的「引擎终态」断言用）。 */
    liveProcesses(name) {
      const h = readState(harnessDir).hosts?.[name];
      if (!h) return [];
      return Object.entries(h.processes)
        .filter(([pid, p]) => {
          if (p.dead) return false;
          try { process.kill(Number(pid), 0); return true; } catch { return false; }
        })
        .map(([pid, p]) => ({ pid: Number(pid), ...p }));
    },

    remoteFiles(name) {
      return readState(harnessDir).hosts?.[name]?.files ?? {};
    },

    /** 杀掉本次装置拉起的全部假 dsh web，清理临时目录。 */
    cleanup() {
      const state = readState(harnessDir);
      for (const h of Object.values(state.hosts ?? {})) {
        for (const pid of Object.keys(h.processes ?? {})) {
          try { process.kill(Number(pid), 'SIGKILL'); } catch { /* 已退出 */ }
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** scenarios.js 的助手默认读 process.env.DSHC_HARNESS_DIR，此处临时切过去。 */
function withDir(dir, fn) {
  const saved = process.env.DSHC_HARNESS_DIR;
  process.env.DSHC_HARNESS_DIR = dir;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.DSHC_HARNESS_DIR;
    else process.env.DSHC_HARNESS_DIR = saved;
  }
}

export { newHostState, hostState };
