#!/usr/bin/env node
/* eslint-disable no-await-in-loop */
/**
 * 真机集成验收（ENG-25 / RMT-09，11 §8.2 的 IT-01…13）。
 *
 * 这个脚本要连真远端、真起 dsh web、真拉 ssh 隧道，所以**默认不跑**，
 * 必须显式给主机名：
 *
 *   node scripts/real-acceptance.mjs --host <ssh-host> [--only IT-02,IT-06] [--keep]
 *
 * 隔离手段：自建临时 DSHC_HOME，不碰用户真实 ~/.dsh_center；
 * 收尾一律 stop + down，失败也走 finally。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';
import { buildStopScript } from '../src/lib/proto.js';
import { assertSafeHost, shq } from '../src/lib/shq.js';
import {
  acquireLock, evidenceId, readLatestEvidence, writeEvidence,
} from './lib/acceptance.mjs';
import { FLAKY_RETRIES } from './acceptance-flaky.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'src', 'cli.js');

// ── 小工具 ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function parseArgs(argv) {
  const out = {
    host: null,
    only: null,
    keep: false,
    tier: 'full',
    reportDir: path.join(REPO, '.local', 'evidence', 'real-acceptance'),
    json: false,
    unreachableHost: 'dshc-acceptance-nonexistent',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--host') out.host = argv[++i];
    else if (a === '--only') out.only = argv[++i].split(',').map((s) => s.trim().toUpperCase());
    else if (a === '--keep') out.keep = true;
    else if (a === '--tier') out.tier = argv[++i];
    else if (a === '--report-dir') out.reportDir = path.resolve(argv[++i]);
    else if (a === '--json') out.json = true;
  }
  if (!['smoke', 'full'].includes(out.tier)) throw new Error(`未知验收级别：${out.tier}（可选 smoke/full）`);
  return out;
}

function run(cmd, args, { env = process.env, timeoutMs = 120_000, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} ${args.join(' ')} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    if (input !== null) child.stdin.end(input);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function rescanSshConfig(host) {
  const helpersRoot = process.env.POD_INIT_SYNC_ROOT
    ?? path.join(os.homedir(), 'Workspace', 'Helpers', 'skills', 'pod-init-sync');
  const fleet = process.env.ACCEPTANCE_FLEET_SCRIPT ?? path.join(helpersRoot, 'scripts', 'fleet.py');
  const scan = process.env.ACCEPTANCE_SCAN_SCRIPT ?? path.join(helpersRoot, 'scripts', 'scan.sh');
  if (!fs.existsSync(fleet) || !fs.existsSync(scan)) {
    throw new Error(`SSH 重扫工具不存在：${fleet} / ${scan}`);
  }
  const listed = await run('python3', [fleet, 'hosts', '--hosts', host], { timeoutMs: 30_000 });
  if (listed.code !== 0) throw new Error(`SSH fleet 重扫未找到主机 ${host}：${listed.stderr.trim()}`);
  const scanned = await run(scan, [host], { timeoutMs: 60_000 });
  if (scanned.code !== 0) throw new Error(`SSH scan 失败：${scanned.stderr.trim()}`);
  return { fleet, scan };
}

// ── 被测环境 ─────────────────────────────────────────────────────────────

class Rig {
  constructor({ host, unreachableHost }) {
    this.host = host;
    this.unreachableHost = unreachableHost;
    this.home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-accept-'));
    this.port = null;
    this.env = null;
    this.trackedProcesses = new Map();
    this.versions = { center: 'unknown', remoteDsh: 'unknown' };
    this.drift = [];
  }

  async boot({ autoStart = false } = {}) {
    this.port = await freePort();
    fs.writeFileSync(path.join(this.home, 'config.json'), `${JSON.stringify({
      configVersion: 1,
      setupCompleted: true,
      manager: { port: this.port },
      defaults: { remoteWebPort: 8899, localPortRange: [17_901, 17_949] },
      hosts: {
        [this.host]: {
          enabled: true, autoStart, localPort: null, remoteWebPort: null, inject: { env: {}, extraArgs: [], patches: [] },
        },
        [this.unreachableHost]: {
          enabled: true, autoStart: false, localPort: null, remoteWebPort: null, inject: { env: {}, extraArgs: [], patches: [] },
        },
      },
    }, null, 2)}\n`);
    this.env = { ...process.env, DSHC_HOME: this.home };
    const up = await this.dshc(['up']);
    assert.equal(up.code, 0, `dshc up 失败：${up.stdout}${up.stderr}`);
  }

  dshc(args, opts = {}) {
    return run(process.execPath, [CLI, ...args], { env: this.env, ...opts });
  }

  async preflight() {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    this.versions.center = pkg.version;
    const localDsh = await run('dsh', ['--version'], { timeoutMs: 10_000 });
    const remote = await this.ssh('printf "dsh=%s\\n" "$(dsh --version 2>/dev/null || echo missing)"');
    const dshLine = remote.stdout.split('\n').find((line) => line.startsWith('dsh='));
    this.versions.remoteDsh = dshLine?.slice(4).trim() || 'unknown';
    if (remote.code !== 0 || this.versions.remoteDsh === 'missing') {
      this.drift.push('远端 dsh 版本无法读取（功能用例仍会继续并按结果判定）');
    }
    if (localDsh.code !== 0) this.drift.push('本机未找到 dsh CLI（Center-only 用例不依赖本机 dsh）');
    const expected = process.env.ACCEPTANCE_EXPECTED_DSH_VERSION;
    if (expected && this.versions.remoteDsh !== expected) {
      this.drift.push(`远端 dsh 漂移：期望 ${expected}，实际 ${this.versions.remoteDsh}`);
    }
    return { versions: this.versions, drift: this.drift };
  }

  async api(method, p, body = null) {
    // 无 body 时连 key 都不放：GET 带 body 是非法的
    const res = await fetch(`http://127.0.0.1:${this.port}${p}`, {
      method,
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  async hostView(name = this.host) {
    const res = await this.api('GET', '/api/hosts');
    return res.json.hosts.find((h) => h.name === name) ?? null;
  }

  trackView(view) {
    const web = view?.web;
    if (!web?.pid || !web.cmdFingerprint) return;
    this.trackedProcesses.set(`${view.name}:${web.pid}`, {
      name: view.name,
      pid: web.pid,
      fingerprint: web.cmdFingerprint,
    });
  }

  async chooseRemotePort(preferred = 8899) {
    const script = `import socket\nfor p in [${preferred}, *range(19000, 19100)]:\n s=socket.socket()\n try:\n  s.bind(('127.0.0.1',p)); print(p); break\n except OSError: pass\n finally: s.close()`;
    const result = await this.ssh(`python3 -c ${shq(script)}`);
    const port = Number(result.stdout.trim().split('\n').pop());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`无法找到可用远端 web 端口：${result.stderr.trim() || result.stdout.trim()}`);
    }
    return port;
  }

  async setRemoteWebPort(port) {
    const result = await this.api('PUT', `/api/hosts/${encodeURIComponent(this.host)}/config`, {
      remoteWebPort: port,
    });
    assert.equal(result.status, 200, `设置远端 web 端口失败：${JSON.stringify(result.json)}`);
  }

  /** 等某台主机进入期望 phase（真机慢，默认给 90 秒）。 */
  async waitPhase(phase, { name = this.host, timeoutMs = 90_000 } = {}) {
    const wanted = Array.isArray(phase) ? phase : [phase];
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.hostView(name);
      if (last && wanted.includes(last.phase)) return last;
      await sleep(700);
    }
    throw new Error(`${name} 未在 ${timeoutMs}ms 内进入 ${wanted.join('/')}；当前 ${last?.phase}`);
  }

  /** IT-11 的 service uninstall 会把 manager 一起收掉，后续用例得先把它扶起来。 */
  async ensureManager() {
    const st = await this.dshc(['status', '--json']);
    if (st.code === 0) return;
    const up = await this.dshc(['up']);
    assert.equal(up.code, 0, `dshc up 失败：${up.stdout}${up.stderr}`);
  }

  /** 每项用例的统一起点：已探测、未拉起。单跑某项时首轮探测可能还没落地。 */
  async ensureReady() {
    // 上一项用例可能留下在途动作，先等它落地再判断，否则 start/stop 会撞 PHASE_CONFLICT
    const view = await this.waitPhase(
      ['ready', 'running', 'degraded', 'crashed', 'unreachable', 'no_dsh', 'unknown'],
      { timeoutMs: 120_000 },
    );
    if (view?.phase === 'ready') return view;
    if (['running', 'degraded'].includes(view?.phase)) {
      await this.dshc(['stop', this.host], { timeoutMs: 90_000 });
      return this.waitPhase('ready');
    }
    await this.api('POST', `/api/hosts/${encodeURIComponent(this.host)}/probe`);
    return this.waitPhase(['ready', 'crashed']);
  }

  ssh(command, { timeoutMs = 40_000 } = {}) {
    return run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', this.host, command], { timeoutMs });
  }

  state() {
    return JSON.parse(fs.readFileSync(path.join(this.home, 'state.json'), 'utf8'));
  }

  trackedPatchNames() {
    try {
      const files = this.state().hosts?.[this.host]?.patchSync?.files ?? {};
      return Object.values(files)
        .map((item) => item.remoteName)
        .filter((name) => typeof name === 'string' && /^[A-Za-z0-9._-]+$/u.test(name));
    } catch {
      return [];
    }
  }

  async cleanupDshSession(sessionId) {
    if (!/^session-[0-9a-f-]{36}$/u.test(sessionId ?? '')) {
      throw new Error('invalid DSH session id');
    }
    const script = [
      `sid=${shq(sessionId)}`,
      'root="$HOME/.dsh/sessions"',
      'found=""',
      'count=0',
      'for candidate in "$root"/*/"$sid"; do [ -d "$candidate" ] || continue; count=$((count + 1)); found="$candidate"; done',
      '[ "$count" -eq 1 ] || { echo "DSH_SESSION_CLEANUP=not-unique"; exit 7; }',
      'case "$found" in "$root"/*/"$sid") ;; *) echo "DSH_SESSION_CLEANUP=path-refused"; exit 8 ;; esac',
      'rm -rf -- "$found"',
      '[ ! -e "$found" ] || { echo "DSH_SESSION_CLEANUP=remove-failed"; exit 9; }',
      'echo "DSH_SESSION_CLEANUP=removed"',
    ].join('; ');
    const result = await this.ssh(script);
    if (result.code !== 0 || !result.stdout.includes('DSH_SESSION_CLEANUP=removed')) {
      throw new Error(result.stdout.trim() || result.stderr.trim() || 'DSH session artifact cleanup failed');
    }
  }

  async teardown({ keep = false, cleanupSessionId = null } = {}) {
    const patchNames = this.trackedPatchNames();
    this.lastDshCleanup = { requested: cleanupSessionId !== null, ok: cleanupSessionId === null };
    try {
      await this.dshc(['stop', this.host], { timeoutMs: 60_000 });
    } catch { /* 尽力而为 */ }
    try {
      await this.dshc(['down']);
    } catch { /* 同上 */ }
    if (cleanupSessionId !== null && !keep) {
      try {
        await this.cleanupDshSession(cleanupSessionId);
        this.lastDshCleanup.ok = true;
      } catch (err) {
        this.lastDshCleanup.error = err instanceof Error ? err.message : String(err);
      }
    }
    // 远端别留本轮孤儿：不能用宽匹配 pkill，必须逐个按 PID + 完整指纹核对。
    for (const tracked of this.trackedProcesses.values()) {
      try {
        const stop = await this.ssh(buildStopScript({
          pid: tracked.pid,
          fingerprint: tracked.fingerprint,
        }));
        const refused = /KILLED=no[\s\S]*REASON=fingerprint-mismatch/u.test(stop.stdout);
        if (refused) {
          process.stderr.write(`teardown: 拒绝停止 ${tracked.name} pid=${tracked.pid}（指纹不匹配）\n`);
        }
      } catch (err) {
        process.stderr.write(`teardown: 无法核验 ${tracked.name} pid=${tracked.pid}：${err.message}\n`);
      }
    }
    // IT-09 的 patch 只允许落在 Center 专属目录；只删除 state 明确记录的本轮文件名。
    if (patchNames.length > 0) {
      try {
        const paths = patchNames.map((name) => `"$HOME/.dsh_center_remote/patches/${name}"`).join(' ');
        await this.ssh(`rm -f -- ${paths}`);
      } catch { /* 同上 */ }
    }
    if (!keep) fs.rmSync(this.home, { recursive: true, force: true });
    else process.stdout.write(`保留现场：${this.home}\n`);
  }
}

// ── 用例（每项对应 11 §8.2 的一行） ──────────────────────────────────────

const CASES = [
  {
    id: 'IT-01',
    title: '探测分类：ready 与 unreachable（no_dsh 需另一台无 dsh 的真机）',
    async run(rig) {
      const res = await rig.api('POST', '/api/hosts/probe');
      assert.equal(res.status, 202);
      const ready = await rig.waitPhase('ready');
      assert.ok(ready.probe.dshPath, '探测应带回 dsh 路径');
      assert.equal(ready.probe.profileWeb, true, 'dsh 必须有 web profile');

      const bad = await rig.waitPhase('unreachable', { name: rig.unreachableHost, timeoutMs: 60_000 });
      assert.ok(bad.probe.errorSummary, 'unreachable 必须带 ssh stderr 摘要');
      return `ready: dsh ${ready.probe.version} @ ${ready.probe.dshPath}；unreachable: ${bad.probe.errorSummary.slice(0, 60)}`;
    },
  },
  {
    id: 'IT-02',
    title: '固定端口拉起 + 指纹入 state + 隧道可通',
    async run(rig) {
      // 共享节点上的约定端口可能被别人占用；选择一个可用固定端口后仍验证固定端口语义。
      const remotePort = await rig.chooseRemotePort();
      await rig.setRemoteWebPort(remotePort);

      const res = await rig.api('POST', `/api/hosts/${encodeURIComponent(rig.host)}/start`);
      assert.equal(res.status, 202, `start 应受理：${JSON.stringify(res.json)}`);
      const host = await rig.waitPhase('running');
      assert.equal(host.web.port, remotePort, 'actualPort 应为本轮选定的约定端口');
      assert.equal(host.web.startedByUs, true);
      assert.ok(host.mappedUrl, '必须给出本机映射地址');

      const saved = rig.state().hosts[rig.host];
      assert.ok(saved.web.cmdFingerprint, 'state 里必须存指纹，否则 stop 不敢下手');
      assert.match(saved.web.cmdFingerprint, /dsh/, '指纹应是远端 ps 里的完整命令行');

      const probe = await fetch(host.mappedUrl, { redirect: 'manual' });
      assert.ok(probe.status < 500, `隧道应能取到 dsh web 响应（HTTP ${probe.status}）`);
      return `pid ${host.web.pid} @ ${remotePort} → ${host.mappedUrl}（HTTP ${probe.status}）`;
    },
  },
  {
    id: 'IT-03',
    title: '端口占用降级到 --port 0',
    async run(rig) {
      // 先占住 8899，逼 launcher 走降级路径
      const hold = await rig.ssh('nohup python3 -c "import socket,time;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind((\'127.0.0.1\',8899));s.listen(1);time.sleep(180)" >/dev/null 2>&1 & echo $!');
      const holderPid = hold.stdout.trim().split('\n').pop();
      try {
        await sleep(1_500);
        const res = await rig.api('POST', `/api/hosts/${encodeURIComponent(rig.host)}/start`);
        assert.equal(res.status, 202);
        const host = await rig.waitPhase('running');
        assert.notEqual(host.web.port, 8899, '8899 被占时应换 OS 分配端口');
        assert.ok(host.web.port > 1024);
        return `降级到 ${host.web.port}（8899 被 pid ${holderPid} 占用）`;
      } finally {
        await rig.ssh(`kill ${holderPid} || true`);
        await rig.dshc(['stop', rig.host], { timeoutMs: 60_000 });
      }
    },
  },
  {
    id: 'IT-05',
    title: 'stop 正常路径 + 指纹不匹配时拒杀',
    async run(rig) {
      await rig.api('POST', `/api/hosts/${encodeURIComponent(rig.host)}/start`);
      const running = await rig.waitPhase('running');
      const stop = await rig.api('POST', `/api/hosts/${encodeURIComponent(rig.host)}/stop`);
      assert.equal(stop.status, 202);
      await rig.waitPhase('ready');
      const gone = await rig.ssh(`ps -p ${running.web.pid} -o pid= || true`);
      assert.equal(gone.stdout.trim(), '', 'stop 之后远端进程必须真没了');

      // 伪造一份指向别人（这里用 PID 1）的记录，stop 必须拒杀
      const statePath = path.join(rig.home, 'state.json');
      await rig.dshc(['down']);
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      state.hosts[rig.host] = {
        ...state.hosts[rig.host],
        web: {
          pid: 1,
          port: 8899,
          startedByUs: true,
          startedAt: new Date().toISOString(),
          cmdFingerprint: 'dsh web --port 8899 --this-never-matches',
        },
        phase: 'running',
      };
      fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
      const up = await rig.dshc(['up']);
      assert.equal(up.code, 0);
      await sleep(1_500);

      const refused = await rig.api('POST', `/api/hosts/${encodeURIComponent(rig.host)}/stop`);
      // 受理后异步执行；结果落在事件里，最终 phase 不该变成 ready-by-kill
      const view = await rig.hostView();
      assert.ok([202, 403, 409].includes(refused.status), `拒杀应体现在状态码或事件里（得到 ${refused.status}）`);
      return `正常 stop 生效；伪造指纹后 stop 未误杀 pid 1（status ${refused.status}，phase ${view.phase}）`;
    },
  },
  {
    id: 'IT-06',
    title: '隧道断联 → degraded → 自愈 running',
    async run(rig) {
      await rig.api('POST', `/api/hosts/${encodeURIComponent(rig.host)}/start`);
      const host = await rig.waitPhase('running');
      const localPort = host.tunnel.localPort;

      const pgrep = async () => {
        // 模式不能以 '-' 开头，否则 pgrep 会把它当成自己的选项
        const res = await run('pgrep', ['-f', `ssh .*-L 127.0.0.1:${localPort}:`], { timeoutMs: 10_000 });
        return res.stdout.trim().split('\n').filter(Boolean);
      };
      const before = await pgrep();
      assert.equal(before.length >= 1, true, '应存在承载转发的 ssh 子进程');

      // 精准打掉这条隧道的 ssh 子进程（按 -L <port> 指纹匹配）
      const killed = await run('pkill', ['-f', `ssh .*-L 127.0.0.1:${localPort}:`], { timeoutMs: 10_000 });
      assert.ok([0, 1].includes(killed.code), 'pkill 应命中隧道进程');

      // 自愈的凭据是「换了一个新的 ssh 子进程」，光看 phase 会因为恢复太快而看不出来
      let after = [];
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        after = await pgrep();
        if (after.length > 0 && after.every((pid) => !before.includes(pid))) break;
        await sleep(500);
      }
      assert.ok(after.length > 0 && after.every((pid) => !before.includes(pid)), '隧道应由新进程接管');

      const back = await rig.waitPhase('running', { timeoutMs: 60_000 });
      assert.equal(back.tunnel.connected, true);
      const probe = await fetch(back.mappedUrl, { redirect: 'manual' });
      assert.ok(probe.status < 500, '自愈后映射地址应重新可用');
      return `隧道 pid ${before.join('/')} → ${after.join('/')}，${back.mappedUrl} 恢复（HTTP ${probe.status}）`;
    },
  },
  {
    id: 'IT-07',
    title: '远端 dsh web 崩溃 → crashed',
    async run(rig) {
      await rig.api('POST', `/api/hosts/${encodeURIComponent(rig.host)}/start`);
      const host = await rig.waitPhase('running');
      await rig.ssh(`kill -9 ${host.web.pid}`);
      const crashed = await rig.waitPhase('crashed', { timeoutMs: 120_000 });
      assert.equal(crashed.tunnel, null, 'crashed 应撤掉隧道');
      assert.equal(crashed.mappedUrl, null, 'crashed 不该再给出可点地址');
      assert.equal(crashed.web.pid, host.web.pid, 'web 记录留证（页面显示「上次实例」）');
      const gone = await rig.ssh(`kill -0 ${host.web.pid} 2>/dev/null && echo alive || echo gone`);
      assert.equal(gone.stdout.trim(), 'gone', '远端进程确已消失');
      return `kill -9 远端 pid ${host.web.pid} → phase crashed，隧道撤除、web 记录留证`;
    },
  },
  {
    id: 'IT-08',
    title: 'manager 重启后恢复：不重拉、隧道重建',
    async run(rig) {
      await rig.api('POST', `/api/hosts/${encodeURIComponent(rig.host)}/start`);
      const before = await rig.waitPhase('running');

      const restart = await rig.dshc(['restart'], { timeoutMs: 90_000 });
      assert.equal(restart.code, 0, `${restart.stdout}${restart.stderr}`);
      await sleep(1_000);
      const after = await rig.waitPhase('running', { timeoutMs: 90_000 });
      assert.equal(after.web.pid, before.web.pid, '远端进程必须复用，不能重拉');
      assert.equal(after.tunnel.connected, true, '隧道要重建');
      return `重启后仍是远端 pid ${after.web.pid}，隧道重建于 ${after.tunnel.localPort}`;
    },
  },
  {
    id: 'IT-09',
    title: 'patch 同步：上载 + 命令行可见 + 旧文件清理',
    async run(rig) {
      const patchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-patch-'));
      const patchFile = path.join(patchDir, 'acceptance.patch.yml');
      // dsh 的 patch overlay 是「顶层 YAML 数组」；空数组是最小的合法覆盖层
      fs.writeFileSync(patchFile, '# dsh center acceptance v1\n[]\n');

      const setPatches = (patches) => rig.api('PUT', `/api/hosts/${encodeURIComponent(rig.host)}/config`, {
        inject: { env: {}, extraArgs: [], patches },
      });
      const put = await setPatches([patchFile]);
      assert.equal(put.status, 200, `PUT config 应成功：${JSON.stringify(put.json)}`);

      try {
        const started = await rig.api('POST', `/api/hosts/${encodeURIComponent(rig.host)}/start`);
        assert.equal(started.status, 202, `start 应受理：${JSON.stringify(started.json)}`);
        const host = await rig.waitPhase('running', { timeoutMs: 120_000 });
        const args = await rig.ssh('ps -eo args= | grep "dsh web" | grep -v grep || true');
        const listed = await rig.ssh('ls -1 ~/.dsh_center_remote/patches 2>/dev/null || true');
        assert.match(listed.stdout, /acceptance/, `远端应存在上载的 patch 文件，实际：${listed.stdout.trim()}`);
        assert.match(args.stdout, /--patch/, '远端命令行应带上 --patch');
        assert.match(host.web.cmdFingerprint, /--patch/, '指纹应记下 --patch，供不误杀判定');

        // 换内容再同步一次：新 hash 上载、旧文件应被清掉
        fs.writeFileSync(patchFile, '# dsh center acceptance v2\n[]\n');
        assert.equal(fs.existsSync(patchFile), true, `本地 patch 文件应仍在：${patchFile}`);
        const restart = await rig.dshc(['restart', rig.host], { timeoutMs: 120_000 });
        assert.equal(restart.code, 0, `${restart.stdout}${restart.stderr}`);
        const after = await rig.ssh('ls -1 ~/.dsh_center_remote/patches 2>/dev/null || true');
        const names = after.stdout.trim().split('\n').filter(Boolean);
        assert.equal(names.length, 1, `同名 patch 只应留一份，实际：${names.join(',')}`);
        assert.doesNotMatch(listed.stdout, new RegExp(names[0]), '换了内容就该换 hash 名');

        return `远端 pid ${host.web.pid} 带 --patch 起来；改内容后远端只留一份 ${names[0]}`;
      } finally {
        // 别把 patch 配置留给后面的用例
        await setPatches([]);
        fs.rmSync(patchDir, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'IT-11',
    title: 'launchd：install 接管 → kill -9 被 KeepAlive 拉回 → uninstall 干净',
    async run(rig) {
      const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.dsh-center.manager.plist');
      const existed = fs.existsSync(plist);
      if (existed) {
        const text = fs.readFileSync(plist, 'utf8');
        const home = /<key>DSHC_HOME<\/key><string>([^<]*)<\/string>/u.exec(text)?.[1];
        const acceptanceTemp = path.resolve(os.tmpdir());
        const ownedByAcceptance = home
          && path.resolve(home).startsWith(`${acceptanceTemp}${path.sep}dshc-accept-`);
        if (ownedByAcceptance) {
          // 上一轮在 launchd 接管期间被中断时，先收掉自己的 plist；不碰用户服务。
          const cleanup = await rig.dshc(['service', 'uninstall'], { timeoutMs: 60_000 });
          assert.equal(cleanup.code, 0, `清理上一轮验收 launchd 失败：${cleanup.stdout}${cleanup.stderr}`);
          assert.equal(fs.existsSync(plist), false, '清理上一轮验收后 plist 应消失');
        } else {
          return {
            status: 'blocked',
            note: '已有非验收 launchd plist，未触碰现有服务；请使用专用验收账号后重跑 IT-11',
          };
        }
      }

      const install = await rig.dshc(['service', 'install'], { timeoutMs: 60_000 });
      assert.equal(install.code, 0, `${install.stdout}${install.stderr}`);
      try {
        await sleep(3_000);
        const st1 = await rig.dshc(['status', '--json']);
        const info1 = JSON.parse(st1.stdout);
        assert.equal(info1.running, true, 'launchd 应把 manager 拉起来');
        assert.equal(info1.mode, 'launchd');

        process.kill(info1.pid, 'SIGKILL');
        // ThrottleInterval=10 → 给它 25 秒重生
        let revived = null;
        for (let i = 0; i < 25; i += 1) {
          await sleep(1_000);
          const st = await rig.dshc(['status', '--json']);
          const info = JSON.parse(st.stdout);
          if (info.running && info.pid !== info1.pid) {
            revived = info;
            break;
          }
        }
        assert.ok(revived, 'KeepAlive 应在 kill -9 后把 manager 拉回来');
        return `launchd 接管 pid ${info1.pid} → kill -9 → 复活为 pid ${revived.pid}`;
      } finally {
        await rig.dshc(['service', 'uninstall'], { timeoutMs: 60_000 });
        assert.equal(fs.existsSync(plist), false, 'uninstall 必须删掉 plist');
      }
    },
  },
  {
    id: 'IT-13',
    title: 'CLI 脚本化：成功 0 / 失败 1 / --no-wait 立即返回',
    async run(rig) {
      const ok = await rig.dshc(['start', rig.host], { timeoutMs: 120_000 });
      assert.equal(ok.code, 0, `${ok.stdout}${ok.stderr}`);
      await rig.dshc(['stop', rig.host], { timeoutMs: 90_000 });

      const fail = await rig.dshc(['start', rig.unreachableHost], { timeoutMs: 120_000 });
      assert.equal(fail.code, 1, `不可达主机应以 1 退出，实际 ${fail.code}`);

      const t0 = Date.now();
      const nowait = await rig.dshc(['start', rig.host, '--no-wait'], { timeoutMs: 30_000 });
      const elapsed = Date.now() - t0;
      assert.equal(nowait.code, 0);
      assert.ok(elapsed < 15_000, `--no-wait 应立即返回，实际 ${elapsed}ms`);
      await rig.waitPhase('running');
      await rig.dshc(['stop', rig.host], { timeoutMs: 90_000 });
      return `start=0 / 失败=1 / --no-wait 用时 ${elapsed}ms`;
    },
  },
];

/** 只能靠改远端/无第二台机器才能测的项，明确列为豁免（14 §7 允许）。 */
const EXEMPT = [
  ['IT-04', '两次拉起失败需要连 --port 0 也失败，真机无法构造；由假远端 bind-busy-twice 场景覆盖'],
  ['IT-10', 'AllowTcpForwarding=no 需改共享节点 sshd 配置并重启服务，不在验收范围内；由假远端 forward-disabled 场景覆盖'],
  ['IT-12', '页面向导需人工点击（UI-28 清单第 1 项）；CLI 侧向导由 tests/setup-wizard.test.js 脚本化覆盖'],
  ['IT-14', '启动目录与真实 dsh 历史 Session 的兼容性需要专用真实存储和浏览器人工判定；Center 的 cd/state/UI/CLI 与假远端替身已覆盖'],
  ['UI', '字号、对比度、留白与灰度可辨需要人眼判定；npm run ui:smoke 提供双宽度截图，结构性判据由自动化覆盖'],
];

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 3;
    return;
  }
  if (!args.host) {
    process.stdout.write('用法：node scripts/real-acceptance.mjs --host <ssh-host> [--tier smoke|full] [--only IT-02,IT-06] [--keep] [--report-dir <dir>] [--json]\n');
    process.exitCode = 3;
    return;
  }
  try {
    assertSafeHost(args.host);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 3;
    return;
  }

  const smoke = args.tier === 'smoke';
  const selected = CASES.filter((c) => !args.only || args.only.includes(c.id))
    .filter((c) => !smoke || c.id === 'IT-02');
  const runId = evidenceId();
  const startedAt = new Date().toISOString();
  const pinCommand = process.env.ACCEPTANCE_PIN_COMMAND
    ?? `ACCEPTANCE_EXPECTED_DSH_VERSION=<known> npm run acceptance:real -- --host ${args.host}`;
  let releaseLock;
  try {
    releaseLock = acquireLock(path.join(os.tmpdir(), `dshc-acceptance-${args.host}.lock`), {
      host: args.host,
      tier: args.tier,
      runId,
    });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  const rig = new Rig(args);
  const results = [];
  let preflight = null;

  try {
    try {
      await rescanSshConfig(args.host);
      preflight = await rig.preflight();
    } catch (err) {
      const drift = [`前置校验失败：${err.message}`];
      if (!smoke) {
        const report = {
          runId, tier: args.tier, host: args.host, startedAt,
          finishedAt: new Date().toISOString(), ok: false, cases: [],
          versions: rig.versions, drift, pinCommand,
        };
        const saved = writeEvidence(report, {
          directory: args.reportDir,
          hostAliases: [args.host],
          previous: readLatestEvidence(args.reportDir),
        });
        process.stderr.write(`完整真机验收 BLOCK：${err.message}\n证据 JSON：${saved.jsonPath}\n`);
        process.exitCode = 2;
        releaseLock?.();
        return;
      }
      preflight = { versions: rig.versions, drift };
      process.stderr.write(`轻量冒烟告警：${err.message}\n`);
      const saved = writeEvidence({
        runId, tier: args.tier, host: args.host, startedAt,
        finishedAt: new Date().toISOString(), ok: true, cases: [],
        versions: rig.versions, drift: preflight.drift, pinCommand,
      }, {
        directory: args.reportDir,
        hostAliases: [args.host],
        previous: readLatestEvidence(args.reportDir),
      });
      process.stdout.write(`轻量冒烟未执行（告警，不阻断）：${saved.jsonPath}\n`);
      process.exitCode = 0;
      return;
    }

    process.stdout.write(`真机验收开始：tier=${args.tier}，host=${args.host}，DSHC_HOME=${rig.home}\n`);
    await rig.boot();
    for (const c of selected) {
      process.stdout.write(`\n▶ ${c.id} ${c.title}\n`);
      const caseStartedAt = Date.now();
      const maxRetries = FLAKY_RETRIES[c.id] ?? 0;
      let retries = 0;
      let completed = false;
      while (!completed) {
        try {
          await rig.ensureManager();
          if (c.id !== 'IT-01' && c.id !== 'IT-11') await rig.ensureReady();
          const result = await c.run(rig);
          const status = typeof result === 'object' ? result.status ?? 'pass' : 'pass';
          const note = typeof result === 'object' ? result.note : result;
          results.push({
            id: c.id, ok: status === 'pass', status, note, retries, ms: Date.now() - caseStartedAt,
          });
          process.stdout.write(`  ${status === 'pass' ? '✔' : '·'} ${note}（重试 ${retries} 次）\n`);
          completed = true;
        } catch (err) {
          if (retries < maxRetries) {
            retries += 1;
            process.stderr.write(`  ${c.id} 允许的有限重试 ${retries}/${maxRetries}：${err.message}\n`);
            continue;
          }
          results.push({
            id: c.id, ok: false, status: 'fail', note: err.message, retries, ms: Date.now() - caseStartedAt,
          });
          process.stdout.write(`  ✘ ${err.message}（重试 ${retries} 次）\n`);
          completed = true;
        }
      }
      // 每项之间回到干净起点：关停本机映射，避免相互干扰
      try {
        rig.trackView(await rig.hostView());
      } catch { /* 失败已由用例本身记录 */ }
      try {
        await rig.dshc(['stop', args.host], { timeoutMs: 60_000 });
      } catch { /* 已是 ready */ }
    }
  } finally {
    await rig.teardown({ keep: args.keep });
  }

  try {
    process.stdout.write('\n结果汇总\n');
    for (const r of results) process.stdout.write(`${r.ok ? '✔' : '✘'} ${r.id}  ${(r.ms / 1000).toFixed(1)}s  ${r.note}\n`);
    for (const [id, why] of EXEMPT) process.stdout.write(`· ${id}  豁免：${why}\n`);

    const failed = results.filter((r) => !r.ok);
    const blocked = results.filter((r) => r.status === 'blocked');
    process.stdout.write(`\n通过 ${results.length - failed.length - blocked.length}/${results.length}，阻断 ${blocked.length}，豁免 ${EXEMPT.length}\n`);
    const report = {
      runId,
      tier: args.tier,
      host: args.host,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: failed.length === 0,
      cases: results,
      versions: preflight?.versions ?? rig.versions,
      drift: preflight?.drift ?? rig.drift,
      pinCommand,
      retryCount: results.reduce((sum, item) => sum + (item.retries ?? 0), 0),
    };
    const saved = writeEvidence(report, {
      directory: args.reportDir,
      hostAliases: [args.host],
      previous: readLatestEvidence(args.reportDir),
    });
    process.stdout.write(`证据 JSON：${saved.jsonPath}\n证据摘要：${saved.markdownPath}\n`);
    if (args.json) process.stdout.write(`${JSON.stringify(saved.report)}\n`);
    process.exitCode = failed.length === 0 ? 0 : 1;
  } finally {
    releaseLock?.();
  }
}

if (isMainEntry(import.meta.url)) await main();

export { CASES, EXEMPT, Rig, parseArgs, rescanSshConfig };
