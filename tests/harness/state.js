/**
 * 假远端状态引擎的持久化层（14 §1.2）。
 *
 * 垫片进程（fake-ssh/fake-scp）与测试进程之间经 $DSHC_HARNESS_DIR/state.json 通信，
 * 用目录锁（mkdir 原子）串行读改写，使多次 ssh 调用之间状态持续。
 */

import fs from 'node:fs';
import path from 'node:path';

export function harnessDir(env = process.env) {
  const dir = env.DSHC_HARNESS_DIR;
  if (!dir) throw new Error('DSHC_HARNESS_DIR 未设置（假远端装置未初始化）');
  return dir;
}

const stateFile = (dir) => path.join(dir, 'state.json');
const lockDir = (dir) => path.join(dir, '.lock');

function acquire(dir, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lockDir(dir));
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() > deadline) {
        // 上一个持有者崩溃：强行接管（测试装置，无需保守）
        fs.rmSync(lockDir(dir), { recursive: true, force: true });
        continue;
      }
      // 忙等：垫片进程生命周期极短，自旋比引入异步更简单
      const until = Date.now() + 5;
      while (Date.now() < until) { /* spin */ }
    }
  }
}

function release(dir) {
  fs.rmSync(lockDir(dir), { recursive: true, force: true });
}

export function newHostState(overrides = {}) {
  return {
    dshInstalled: true,
    dshPath: '/usr/bin/dsh',
    dshVersion: '0.1.0-rc.7',
    dshHome: '/root/.dsh',
    profileWeb: true,
    reachable: true,
    /** 最近一次 LAUNCH 收到的启动目录；null = 脚本里没有 cd 段。 */
    workdir: null,
    processes: {},
    files: {},
    logs: {},
    faults: {},
    launchCount: 0,
    ...overrides,
  };
}

export function readState(dir = harnessDir()) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'));
  } catch {
    return { hosts: {} };
  }
}

/**
 * 原子落盘：同目录 tmp + rename。
 *
 * fake-ssh 的 POLL/VERIFY 在锁外读状态（垫片进程短命，读一眼不值当加锁），
 * 直接 writeFileSync 会让它们读到写了一半的 JSON——解析失败被吞成空状态，
 * 于是 VERIFY 报 ALIVE=no，伪造出「拉起后进程已消失」（issue #83）。
 * rename 之后读者只会看到某一个完整版本。
 */
export function writeState(state, dir = harnessDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.state.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, stateFile(dir));
}

/** 加锁读改写。mutator 返回值作为 mutate 的返回值。 */
export function mutate(fn, dir = harnessDir()) {
  acquire(dir);
  try {
    const state = readState(dir);
    const result = fn(state);
    writeState(state, dir);
    return result;
  } finally {
    release(dir);
  }
}

export function host(state, name) {
  state.hosts ??= {};
  state.hosts[name] ??= newHostState();
  return state.hosts[name];
}
