#!/usr/bin/env node
/**
 * dshc —— 本机主入口（11 §6 / 02 §9–§10）。
 *
 * 纪律：主机操作一律走 manager 的 REST API，CLI 不直连 ssh、不读写 state；
 * 唯一例外是 `dshc init` 第 3 步的 probeOnce（此时 server 还不存在，11 §1.3 例外条款）。
 *
 * 退出码：0 成功｜1 操作失败｜2 超时/通信失败｜3 用法错误｜130 等待被 Ctrl-C 打断（操作仍在继续）。
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

import * as daemon from './daemon.js';
import { createAnalysisService } from './analysis.js';
import {
  DEFAULT_CLEANUP_RULES,
  buildCleanupPlan,
  normalizeCleanupRules,
} from './cleanup.js';
import * as updater from './updater.js';
import { FACTORY_DEFAULTS, newFactoryConfig, resolvePaths } from './defaults.js';
import { isMainEntry } from './lib/entry.js';
import {
  RELEASE_REPO, SUMS_FILE, assetUrl, releasesUrl,
} from './lib/bundle.js';
import { DshError } from './lib/errors.js';
import { openerBin } from './lib/ssh.js';
import { BINDABLE_PORT_RANGE, isBindablePort } from './lib/validate.js';
import { canonicalSetupLocalName } from './store.js';
import {
  SETUP_STEPS, buildConfigFromAnswers, defaultAnswers, getByPath, normalizeHostCandidates, previewJson, setByPath,
} from './web/setup-schema.js';
import { buildInstallGuide } from './web/install-guide.js';

// interrupted=130 是 shell 惯例（128+SIGINT）：脚本里要能把「我自己按了 Ctrl-C」
// 和「这事真失败了」分开（issue #108）
export const EXIT = { ok: 0, failed: 1, comm: 2, usage: 3, interrupted: 130 };

// ── argv 解析（ENG-16） ──────────────────────────────────────────────────

const FLAG_SPEC = {
  port: 'number',
  foreground: 'boolean',
  force: 'boolean',
  adopt: 'boolean',
  pid: 'number',
  'force-new': 'boolean',
  apply: 'boolean',
  rules: 'string',
  'no-wait': 'boolean',
  json: 'boolean',
  verbose: 'boolean',
  n: 'number',
  f: 'boolean',
  pre: 'boolean',
  ref: 'string',
  restart: 'boolean',
};

export class UsageError extends Error {}

/**
 * `--key value` / `--key=value` / `-f` / `-n 50`；`--` 之后全部当 positional。
 * 未知旗标抛 UsageError（退出码 3）。
 * @param {string[]} argv
 * @param {{flags:Record<string,'number'|'boolean'|'string'>}} [spec]
 * @returns {{positionals:string[], flags:Record<string,any>}}
 */
export function parseArgv(argv, spec = { flags: FLAG_SPEC }) {
  const flags = {};
  const positionals = [];
  const types = spec.flags ?? {};
  let passthrough = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (passthrough) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      passthrough = true;
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }

    const long = arg.startsWith('--');
    const body = long ? arg.slice(2) : arg.slice(1);
    const eq = body.indexOf('=');
    const name = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? null : body.slice(eq + 1);

    const type = types[name];
    if (!type) throw new UsageError(`未知旗标 ${arg}`);

    if (type === 'boolean') {
      if (inlineValue !== null && !/^(true|false)$/.test(inlineValue)) {
        throw new UsageError(`旗标 --${name} 不接受值`);
      }
      flags[name] = inlineValue === null ? true : inlineValue === 'true';
      continue;
    }

    const raw = inlineValue ?? argv[i + 1];
    if (raw === undefined || (inlineValue === null && String(raw).startsWith('-'))) {
      throw new UsageError(`旗标 --${name} 缺少值`);
    }
    if (inlineValue === null) i += 1;

    if (type === 'number') {
      if (!/^\d+$/.test(String(raw))) throw new UsageError(`旗标 --${name} 需要整数，收到 ${raw}`);
      flags[name] = Number(raw);
    } else {
      flags[name] = String(raw);
    }
  }

  return { positionals, flags };
}

/**
 * 主机名前缀匹配（02 §10）：精确优先 → 唯一前缀 → 歧义报错列候选。
 * @returns {{ok:true, name:string}|{ok:false, error:string, candidates:string[]}}
 */
export function resolveHostArg(input, hosts) {
  const list = [...hosts];
  if (list.includes(input)) return { ok: true, name: input };

  const hits = list.filter((h) => h.startsWith(input));
  if (hits.length === 1) return { ok: true, name: hits[0] };
  if (hits.length === 0) {
    return { ok: false, error: `没有匹配 "${input}" 的主机`, candidates: list };
  }
  return { ok: false, error: `"${input}" 匹配到多台主机，请写全`, candidates: hits };
}

// ── SSE 行解析（纯函数，供 waitTerminal 与单测共用） ─────────────────────

/**
 * 增量 SSE 分帧器：喂 chunk，吐出完整帧。
 * @returns {{push:(chunk:string)=>{type:string,data:any}[]}}
 */
export function createSseParser() {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const frames = [];
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const frame = parseSseFrame(buffer.slice(0, idx));
        if (frame) frames.push(frame);
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf('\n\n');
      }
      return frames;
    },
  };
}

export function parseSseFrame(raw) {
  let type = 'message';
  const data = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // 心跳注释
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  try {
    return { type, data: JSON.parse(data.join('\n')) };
  } catch {
    return null;
  }
}

/**
 * 各操作的终态集（11 §6.2 表）。
 *
 * `afterStarting`：ready 是「拉起回滚」的信号，可它同样是拉起**开始之前**的常态——
 * 先订阅后动作意味着我们会收到动作前的存量帧（上一次 stop 的收尾、探测落地、
 * restart 自己 stop 完那一拍）。所以 start/restart 的 fail 集只在见过一次 starting
 * 之后才生效：真机 IT-09/IT-13 都栽在这里，CLI 报失败退场而拉起还在后台跑，
 * 比单纯误报更糟。兜底仍是 operation-done——它每个 202 动作有且仅有一条。
 */
export const TERMINAL = Object.freeze({
  start: { success: ['running'], fail: ['ready', 'crashed'], afterStarting: true },
  // Adoption has no starting phase; a late ready snapshot from the probe must
  // not be treated as a failed adoption. The operation-done event is the
  // authoritative success/failure signal for this action.
  adopt: { success: ['running'], fail: [] },
  restart: { success: ['running'], fail: ['ready', 'crashed'], afterStarting: true },
  stop: { success: ['ready'], fail: [] },
  reconnect: { success: ['running'], fail: ['crashed'] },
  probe: { success: ['ready', 'no_dsh', 'unreachable'], fail: [] },
});

// ── API 客户端 ───────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor({ status, code, message, detail }) {
    super(message);
    this.status = status;
    this.code = code ?? 'INTERNAL';
    this.detail = detail ?? null;
  }
}

/**
 * config.json 到底怎么了。「没有」「坏了」「读不了」必须分开——把它们一律当成
 * 「尚未初始化」，就会拿「请执行 dshc init」去回答一份只是被截断的配置，而 init
 * 是整份替换：原文里的 localPort 分配、workdir、注入的环境变量与 patch 清单一起没了。
 *
 * @param {string} [file]
 * @returns {{kind:'ok', config:any}|{kind:'missing'}|{kind:'damaged', reason:string}|{kind:'unreadable', reason:string}}
 */
export function classifyConfigFile(file = resolvePaths().config) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { kind: 'missing' };
    // fs 的 message 本来就以错误码开头（`EACCES: permission denied, …`），
    // 再拼一遍 err.code 会读成「EACCES EACCES: …」
    const reason = err.message.startsWith(`${err.code}:`) ? err.message : `${err.code ?? ''} ${err.message}`.trim();
    return { kind: 'unreadable', reason };
  }
  // 空文件不算「没有」：它承载不了配置，可覆盖它照样丢东西（比如上一次写了一半）
  if (text.trim() === '') return { kind: 'damaged', reason: '文件是空的' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { kind: 'damaged', reason: `JSON 解析失败：${err.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'damaged', reason: '顶层不是 JSON 对象' };
  }
  return { kind: 'ok', config: parsed };
}

/** config.manager.port 是 API 的落点；--port 可临时覆盖。 */
function readConfigFile() {
  const v = classifyConfigFile();
  return v.kind === 'ok' ? v.config : null;
}

/**
 * 坏配置在被覆盖前挪到一边。用户手上那份可能还能捞出 localPort 与注入项，
 * 这个动作是「不丢东西」的最后一道保障。
 * @returns {string|null} 备份路径
 */
function backupDamagedConfig(file = resolvePaths().config) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.bad-${stamp}`;
  try {
    fs.copyFileSync(file, dest);
    return dest;
  } catch {
    return null;
  }
}

/** 坏/读不了时的统一说法：说清是什么情形、在哪个文件、往哪儿走。 */
function reportBadConfig(verdict, file = resolvePaths().config) {
  if (verdict.kind === 'unreadable') {
    errOut(`读不了 ${file}（${verdict.reason}）。检查文件权限后重试。`);
    return EXIT.failed;
  }
  errOut(`${file} 已损坏，拒绝启动（${verdict.reason}）。`);
  errOut('里面可能还留着能用的东西（localPort 分配、workdir、注入项）。');
  errOut('先手工修好这份 JSON；确实不要了，就备份后执行 dshc init --force 重来。');
  return EXIT.failed;
}

function managerPort(flags) {
  if (Number.isInteger(flags?.port)) return flags.port;
  const cfg = readConfigFile();
  return Number.isInteger(cfg?.manager?.port) ? cfg.manager.port : FACTORY_DEFAULTS.manager.port;
}

/**
 * manager 不在时的唯一口径。
 *
 * 前置探活（needsServer）与请求半路撞墙是同一件事的两条路，用户不该因为敲的是
 * `start` 还是 `config set` 就看到两套说法（issue #22）。这句话只许有一份。
 */
export function managerDownMessage(port) {
  return `manager 未在 127.0.0.1:${port} 运行。先执行 dshc up。`;
}

function apiRequest(port, method, p, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: p,
      method,
      timeout: 30_000,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        if (res.statusCode >= 400) {
          reject(new ApiError({
            status: res.statusCode,
            code: json?.code,
            message: json?.error ?? `HTTP ${res.statusCode}`,
            detail: json?.detail ?? (json === null ? text : null),
          }));
          return;
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new ApiError({ status: 0, code: 'SSH_TIMEOUT', message: 'manager 响应超时' }));
    });
    req.on('error', (err) => reject(new ApiError({
      status: 0,
      // 端口上没人监听 = manager 没起，这是最常见的一种，给人话而不是 errno
      code: err.code === 'ECONNREFUSED' ? 'MANAGER_DOWN' : 'INTERNAL',
      message: err.code === 'ECONNREFUSED'
        ? managerDownMessage(port)
        : `无法连接 manager（127.0.0.1:${port}）：${err.message}`,
      detail: '先执行 dshc up 启动 manager。',
    })));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 先订阅后动作（11 §6.2）：SSE 开着再发 POST，避免事件竞速。
 * @returns {Promise<{status:'ok'|'failed'|'timeout'|'interrupted', phase:string|null, lastError:string|null}>}
 */
function waitTerminal(port, host, action, { timeoutMs = 120_000, onLog = null, trigger }) {
  const spec = TERMINAL[action];
  return new Promise((resolve, reject) => {
    const parser = createSseParser();
    let settled = false;
    let lastError = null;
    let sawStarting = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      req.destroy();
      resolve(result);
    };

    // Ctrl-C 只是「不等了」，不是「取消」：远端那趟拉起在 manager 那边照常跑完。
    // 接住信号是为了能说出这句实话——默认行为会把 CLI 直接掐掉，一个字都留不下。
    // 不去尝试中止操作：中途掐断远端命令正是孤儿的来源。
    const onSignal = () => finish({ status: 'interrupted', phase: null, lastError });
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    const timer = setTimeout(() => finish({ status: 'timeout', phase: null, lastError }), timeoutMs);

    const req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, async (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        reject(new ApiError({ status: res.statusCode, code: 'INTERNAL', message: `事件流不可用（HTTP ${res.statusCode}）` }));
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        for (const frame of parser.push(chunk)) {
          if (frame.type === 'log-line' && frame.data.host === host) {
            if (frame.data.level === 'error') lastError = frame.data.msg;
            onLog?.(frame.data);
          }
          if (frame.type === 'operation-done' && frame.data.host === host && frame.data.action === action) {
            if (frame.data.status === 'failed') lastError = frame.data.error ?? lastError;
            finish({
              status: frame.data.status === 'ok' ? 'ok' : 'failed',
              phase: null,
              lastError,
            });
          }
          if (frame.type === 'host-changed' && frame.data.host?.name === host) {
            const phase = frame.data.host.phase;
            if (phase === 'starting') sawStarting = true;
            const failArmed = !spec.afterStarting || sawStarting;
            if (spec.success.includes(phase)) finish({ status: 'ok', phase, lastError });
            else if (failArmed && spec.fail.includes(phase)) finish({ status: 'failed', phase, lastError });
          }
        }
      });
      res.on('end', () => finish({ status: 'timeout', phase: null, lastError }));

      // 订阅已建立，现在才发动作
      try {
        await trigger();
      } catch (err) {
        clearTimeout(timer);
        req.destroy();
        settled = true;
        reject(err);
      }
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) reject(new ApiError({ status: 0, code: 'INTERNAL', message: `事件流中断：${err.message}` }));
    });
  });
}

// ── 输出助手 ─────────────────────────────────────────────────────────────

const PHASE_LABEL = {
  running: '运行中',
  degraded: '重连中',
  crashed: '已崩溃',
  ready: '可拉起',
  starting: '启动中',
  no_dsh: '无 dsh',
  unreachable: '不可达',
  unknown: '未探测',
};

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

function errOut(line) {
  process.stderr.write(`${line}\n`);
}

/**
 * 为 no_dsh 主机生成 CLI 安装指引行。嗅探事实只进入展示，不改变 phase 或动作判据。
 * @param {{name?:string,local?:boolean,phase?:string,probe?:object}} host
 * @param {{full?:boolean}} [opts]
 * @returns {string[]}
 */
export function installGuideLines(host, { full = true } = {}) {
  if (host?.phase !== 'no_dsh') return [];
  const name = host.name ?? '<host>';
  if (!full) return [`查看安装指引：dshc probe ${name}`];

  const probe = host.probe ?? {};
  const guide = buildInstallGuide({
    local: host.local === true,
    noDshReason: probe.noDshReason,
    sniff: probe.sniff,
    dshHome: probe.dshHome,
    dependencies: probe.dependencies,
  });
  const lines = [`安装指引：${guide.summary}`];
  for (const check of guide.checks ?? []) {
    const status = check.status === 'pass' ? '通过' : check.status === 'optional' ? '可选' : '待处理';
    lines.push(`  [${status}] ${check.label}：${check.detail}`);
    for (const command of check.commands ?? []) lines.push(`    可复制：${command}`);
  }
  if (probe.sniff?.probePath) lines.push(`  非交互 PATH：${probe.sniff.probePath}`);
  if (Array.isArray(probe.sniff?.paths) && probe.sniff.paths.length > 0) {
    lines.push(`  检测到的 dsh：${probe.sniff.paths.join('、')}`);
  }
  if (probe.sniff?.loginPath) lines.push(`  login shell dsh：${probe.sniff.loginPath}`);
  if (probe.sniff?.version) lines.push(`  嗅探版本：${probe.sniff.version}`);
  lines.push(...guide.steps.map((step, i) => `  ${i + 1}. ${step.replaceAll('dshc probe <host>', `dshc probe ${name}`)}`));
  return lines;
}

/** 等宽表格：中文按两格宽计，避免列错位。 */
function width(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return w;
}

export function formatTable(headers, rows) {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => width(r[i] ?? ''))));
  const line = (cells) => cells.map((c, i) => String(c ?? '') + ' '.repeat(widths[i] - width(c ?? ''))).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

/**
 * 超时或「没能跟对方说上话」的错误码——退出码 2 的判据。
 * 其余（校验不过、相位冲突、拒杀、端口用尽、本机执行/复制失败）都是操作失败，算 1。
 */
const COMM_CODES = new Set(['SSH_TIMEOUT', 'SSH_UNREACHABLE', 'LOCAL_TIMEOUT']);

/** @returns {0|1|2|3} */
export function exitCodeFor({ status, code }) {
  if (status === 0) return EXIT.comm; // 连 manager 都没连上
  if (COMM_CODES.has(code)) return EXIT.comm;
  // 值不合法就是用法错误：命令行上敲错的东西，和 `up --port` 越界同一口径（issue #63）
  return code === 'VALIDATION' ? EXIT.usage : EXIT.failed;
}

/**
 * 这些错的 detail 装的正是用户此刻要的那一句——CONFIG_STALE 是「接下来怎么办」，
 * VALIDATION 是「哪个字段、要什么」。藏在 --verbose 后面等于没说（issue #65、#63）。
 */
const DETAIL_ALWAYS_CODES = new Set(['CONFIG_STALE', 'VALIDATION']);

function reportApiError(err, flags) {
  if (err instanceof ApiError) {
    // manager 没起：那句话本身就是完整交代，别再套「错误：…（MANAGER_DOWN）」
    // 和「加 --verbose」这两层壳（issue #22）
    if (err.code === 'MANAGER_DOWN') {
      errOut(err.message);
      return EXIT.comm;
    }
    errOut(`错误：${err.message}${err.code ? `（${err.code}）` : ''}`);
    if (err.detail) {
      if (flags?.verbose || DETAIL_ALWAYS_CODES.has(err.code)) errOut(err.detail);
      else errOut('加 --verbose 查看完整 detail。');
    }
    return exitCodeFor(err);
  }
  // 本机侧抛的 DshError：detail 装的是文件路径与常见成因，正是此刻要给的那几句
  errOut(`错误：${err.message}`);
  if (err.detail) errOut(err.detail);
  return EXIT.failed;
}

// ── 生命周期命令（ENG-21） ──────────────────────────────────────────────

async function cmdUp({ flags }) {
  // 端口写错是用法错误，在拉起之前就该判掉：否则会 spawn 一个必然绑不上的 manager，
  // 等满 10s 健康检查，最后报「未确认健康」——把人往权限、launchd 的方向带（issue #21）
  if (flags.port !== undefined && !isBindablePort(flags.port)) {
    throw new UsageError(
      `--port 需在 ${BINDABLE_PORT_RANGE.min}–${BINDABLE_PORT_RANGE.max} 之间，收到 ${flags.port}`,
    );
  }

  const check = await daemon.aliveCheck();
  if (check.alive) {
    out(`manager 已在运行：pid ${check.info.pid}，端口 ${check.info.port}，模式 ${check.info.mode}`);
    return EXIT.ok;
  }
  if (check.stale) out('清理了失效的 pidfile（上次进程已不在）。');

  const verdict = classifyConfigFile();
  // 坏了/读不了都不许往下走：往下是「当作没有配置」，交互终端上还会直接进向导
  // 覆盖掉那份可能还能救的文件（issue #52）。
  if (verdict.kind === 'damaged' || verdict.kind === 'unreadable') return reportBadConfig(verdict);

  const cfg = verdict.kind === 'ok' ? verdict.config : null;
  if (cfg?.setupCompleted !== true) {
    if (!process.stdin.isTTY) {
      errOut('尚未初始化配置，且当前不是交互终端。请先在终端执行 dshc init。');
      return EXIT.usage;
    }
    out('尚未初始化配置，先走一遍向导：');
    const code = await cmdInit({ flags: { force: true }, positionals: [] });
    if (code !== EXIT.ok) return code;
  }

  if (flags.foreground) {
    // 前台：直接把 server 跑在当前进程（Ctrl-C 即停），launchd 也走这条路
    const { main } = await import('./server.js');
    const booted = await main({ portOverride: flags.port ?? null });
    out(`manager 前台运行中：http://127.0.0.1:${booted.port}`);
    return EXIT.ok;
  }

  const res = await daemon.launchDetached({ port: flags.port ?? null });
  if (!res.confirmed) {
    // 报了失败就不许有进程留着：否则占端口的人一走，它自己就把端口接过去了（issue #77）
    errOut(res.reaped
      ? `已拉起 pid ${res.pid}，但未在预算内确认健康，已把它收走。查看 ${resolvePaths().log}`
      : `已拉起 pid ${res.pid}，但它自己退了（未确认健康）。查看 ${resolvePaths().log}`);
    return EXIT.comm;
  }
  out(`manager 已启动：pid ${res.pid}，http://127.0.0.1:${res.port}`);
  return EXIT.ok;
}

async function cmdDown() {
  const res = await daemon.stopDaemon();
  if (!res.stopped) {
    out('manager 未在运行。');
    return EXIT.ok;
  }
  out(`manager 已关停（模式 ${res.mode}${res.forced ? '，SIGTERM 超时后强杀' : ''}）。`);
  return EXIT.ok;
}

/** 无参 = manager 重启；带主机名 = 主机重启（11 §6.1 冲突消解）。 */
async function cmdRestart(parsed) {
  if (parsed.positionals.length > 0) return cmdHostAction('restart', parsed);

  const check = await daemon.aliveCheck();
  if (!check.alive) {
    out('manager 未在运行，直接启动。');
    return cmdUp(parsed);
  }
  if (check.info.mode === 'launchd') {
    // launchd 会按 KeepAlive 拉回，走 API 自我重启最稳
    return withApi(parsed, async (port) => {
      await apiRequest(port, 'POST', '/api/manager/restart');
      out('已请求重启，launchd 会拉回新实例。');
      return EXIT.ok;
    });
  }
  await daemon.stopDaemon();
  return cmdUp(parsed);
}

async function cmdStatus({ flags }) {
  const check = await daemon.aliveCheck();
  const service = await daemon.serviceStatus();
  const localSidecar = await createAnalysisService().status();
  const port = check.info?.port ?? managerPort(flags);
  const info = check.remote ?? await daemon.fetchInfo(port);
  let sidecar = localSidecar;
  if (info) {
    try {
      sidecar = (await apiRequest(port, 'GET', '/api/sidecar/status')).json;
    } catch {
      sidecar = { compatible: false, version: null, executable: null, error: 'status unavailable' };
    }
  }

  const report = {
    running: Boolean(info),
    mode: info?.mode ?? check.info?.mode ?? null,
    pid: info?.pid ?? null,
    port: info?.port ?? check.info?.port ?? null,
    uptimeMs: info?.uptimeMs ?? null,
    setupCompleted: info?.setupCompleted ?? (readConfigFile()?.setupCompleted ?? null),
    hosts: info?.hostCounts ?? null,
    pidfile: check.info ?? null,
    pidfileStale: check.stale,
    launchd: service,
    sidecar,
  };

  if (flags.json) {
    out(JSON.stringify(report, null, 2));
    return report.running ? EXIT.ok : EXIT.failed;
  }

  if (!report.running) {
    out('manager：未运行');
    if (check.stale) out(`  pidfile 残留：pid ${check.info.pid}（进程已不在或端口无响应）`);
    if (service.installed) out(`  launchd：已安装 plist${service.loaded ? `，状态 ${service.state}` : '，未加载'}`);
    if (report.setupCompleted !== true) out('  配置：未初始化（先跑 dshc init）');
    return EXIT.failed;
  }

  out(`manager：运行中（${report.mode}）`);
  out(`  pid ${report.pid}  端口 ${report.port}  已运行 ${fmtDuration(report.uptimeMs)}`);
  out(`  Sidecar：${report.sidecar?.version ?? '未找到'}${report.sidecar?.compatible ? '（兼容）' : '（不可用或版本过低）'}`);
  if (report.hosts) {
    out(`  主机 ${report.hosts.total} 台：运行 ${report.hosts.running} / 重连 ${report.hosts.degraded} / 异常 ${report.hosts.crashed}`);
  }
  // 三方核对：不一致时如实列出，不擅自“修正”
  if (check.info && check.info.pid !== report.pid) {
    out(`  ⚠ pidfile 记录 pid ${check.info.pid}，实际 ${report.pid}`);
  }
  if (report.mode === 'launchd' && !service.loaded) {
    out('  ⚠ 自称 launchd 模式，但 launchctl 里查不到该服务');
  }
  if (service.loaded && service.pid && service.pid !== report.pid) {
    out(`  ⚠ launchctl 记录 pid ${service.pid}，实际 ${report.pid}`);
  }
  return EXIT.ok;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分${s % 60}秒`;
  if (s < 86_400) return `${Math.floor(s / 3600)}小时${Math.floor((s % 3600) / 60)}分`;
  return `${Math.floor(s / 86_400)}天${Math.floor((s % 86_400) / 3600)}小时`;
}

async function cmdLogs({ flags }) {
  const file = resolvePaths().log;
  if (!fs.existsSync(file)) {
    errOut(`日志还不存在：${file}`);
    return EXIT.failed;
  }
  const lines = flags.n ?? 200;
  out(tailFile(file, lines).trimEnd());

  if (!flags.f) return EXIT.ok;

  // -f：轮询追加（无依赖版 tail -f；fs.watch 在日志轮转时不可靠）
  let offset = fs.statSync(file).size;
  await new Promise(() => {
    setInterval(() => {
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        return;
      }
      if (size < offset) offset = 0; // 被截断/轮转
      if (size === offset) return;
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = size;
      process.stdout.write(buf.toString('utf8'));
    }, 400);
  });
  return EXIT.ok;
}

/** 只读文件尾部（大日志不整读）。 */
export function tailFile(file, lines, { chunkSize = 64 * 1024 } = {}) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    let pos = size;
    let text = '';
    // 多读一行：从块中间切进来的首行可能是残行，按行数够了再丢掉它
    while (pos > 0 && countLines(text) <= lines) {
      const len = Math.min(chunkSize, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      text = buf.toString('utf8') + text;
    }
    const all = text.replace(/\n$/, '').split('\n');
    const tail = all.slice(Math.max(0, all.length - lines));
    return tail.join('\n');
  } finally {
    fs.closeSync(fd);
  }
}

function countLines(text) {
  return text === '' ? 0 : text.replace(/\n$/, '').split('\n').length;
}

async function cmdService({ positionals }) {
  const sub = positionals[0];
  if (!['install', 'uninstall', 'status'].includes(sub)) {
    throw new UsageError('dshc service install|uninstall|status');
  }
  if (sub === 'install') {
    const res = await daemon.serviceInstall();
    if (!res.ok) {
      errOut(`launchd 安装失败：${res.stderr ?? '未知原因'}`);
      return EXIT.failed;
    }
    out(`已安装并加载 ${res.plist}（崩溃会由 launchd 自动拉回）。`);
    return EXIT.ok;
  }
  if (sub === 'uninstall') {
    const res = await daemon.serviceUninstall();
    if (!res.ok) {
      errOut(`launchd 卸载失败：${res.stderr ?? '未知原因'}`);
      return EXIT.failed;
    }
    out('已卸载 launchd 服务。');
    return EXIT.ok;
  }
  const st = await daemon.serviceStatus();
  out(`plist：${st.installed ? '已安装' : '未安装'}`);
  out(`加载：${st.loaded ? `是（state=${st.state}${st.pid ? `, pid=${st.pid}` : ''}）` : '否'}`);
  return st.loaded ? EXIT.ok : EXIT.failed;
}

// ── 版本与更新 ───────────────────────────────────────────────────────────

async function cmdVersion({ flags }) {
  const info = await updater.collectVersionInfo();
  const sidecar = await createAnalysisService().status();
  if (flags.json) {
    out(JSON.stringify({ ...info, sidecar }, null, 2));
    return EXIT.ok;
  }
  out(`dsh-center ${info.version ?? '（版本号读不出来）'}`);
  out(`安装通道：${info.channelDetail}`);
  // 运行时路径是 bundle 安装的自证：指向 <bundle 根>/runtime/bin/node 才算真用上自带运行时
  out(`Node 运行时：${info.node.version}（${info.node.execPath}）`);
  out(`安装位置：${info.root}`);
  out(`Sidecar：${sidecar.version ?? '未找到'}${sidecar.compatible ? '（兼容）' : '（不可用或版本过低）'}`);
  return info.channel === 'unknown' ? EXIT.failed : EXIT.ok;
}

/**
 * 「无需更新」怎么说。跟着预发布的人在稳定口径下会一直停在旧 rc 上（正式版比 rc 旧，
 * 只会看到「已是最新」），所以有更新的预发布时必须点名，否则这条路是个哑口。
 * @returns {string[]}
 */
export function upToDateLines({ from, pre = false, newerPrerelease = null }) {
  const lines = [`已是最新：v${from}${pre ? '（含预发布口径）' : ''}。`];
  if (newerPrerelease) {
    lines.push(`有更新的预发布 v${newerPrerelease}，要跟就 dshc update --pre。`);
  }
  return lines;
}

/** 更新完要不要重启：默认只提示——重启会瞬断所有隧道页签，时机该由人挑。 */
async function offerRestart(flags) {
  const check = await daemon.aliveCheck();
  if (!check.alive) return EXIT.ok;
  if (!flags.restart) {
    out('manager 还在跑旧代码，改动下次重启才生效：dshc restart');
    return EXIT.ok;
  }
  out('正在重启 manager（隧道会瞬断，页签会自愈重连）…');
  // 复用 restart 的既有分支（launchd 走 API 自我重启，普通模式停了再起）
  return cmdRestart({ positionals: [], flags });
}

async function cmdUpdate({ flags }) {
  const install = updater.resolveInstall();

  if (install.channel === 'unknown') {
    errOut(`认不出这是怎么装的，不敢动：${install.reason}`);
    errOut('重装一次最省事：curl -fsSL https://raw.githubusercontent.com/'
      + `${RELEASE_REPO}/main/install.sh | bash`);
    return EXIT.failed;
  }

  // npm 装的包归 npm 管：dshc 代跑 npm i -g 会踩权限与多包管器的浑水，只指路
  if (install.channel === 'npm') {
    errOut('这是 npm 装的，更新请用：npm i -g @shendeguize/remote-dsh-center@latest'
      + '（跟预发布用 npm i -g @shendeguize/remote-dsh-center@next）');
    return EXIT.failed;
  }

  if (install.channel === 'git') {
    const ref = flags.ref ?? updater.DEFAULT_GIT_REF;
    const res = await updater.updateGit({ root: install.root, ref });
    if (!res.ok) {
      errOut(`更新失败：${res.problem}`);
      return EXIT.failed;
    }
    if (res.action === 'up-to-date') {
      out(`已是 origin/${ref} 的最新提交（${res.from.slice(0, 8)}，版本 ${res.fromVersion}）。`);
      return EXIT.ok;
    }
    out(`已更新：${res.from.slice(0, 8)} → ${res.to.slice(0, 8)}`);
    out(`版本：${res.fromVersion} → ${res.toVersion}（跟的是 origin/${ref}）`);
    return offerRestart(flags);
  }

  const res = await updater.updateBundle({
    root: install.root,
    bundleInfo: install.bundleInfo,
    releasesUrl: releasesUrl(),
    assetUrlFor: ({ tag, name }) => assetUrl({ tag, name }),
    sumsUrlFor: ({ tag }) => assetUrl({ tag, name: SUMS_FILE }),
    includePrerelease: Boolean(flags.pre),
    pinned: flags.ref ?? null,
  });

  if (res.action === 'none') {
    errOut(`没找到可装的版本：${res.reason}`);
    return EXIT.failed;
  }
  if (res.action === 'up-to-date') {
    for (const line of upToDateLines({ from: res.from, pre: Boolean(flags.pre), newerPrerelease: res.newerPrerelease })) {
      out(line);
    }
    return EXIT.ok;
  }
  out(`已更新：v${res.from} → v${res.to}`);
  out(`上一版留在 ${res.previous}（要回滚就把它换回来）。`);
  return offerRestart(flags);
}

// ── 主机操作命令（ENG-22） ──────────────────────────────────────────────

/** 需要 manager 在跑的命令统一入口：拿端口 + 统一错误处理。 */
async function withApi(parsed, fn) {
  const port = managerPort(parsed.flags);
  try {
    return await fn(port);
  } catch (err) {
    // 参数写错不是「操作失败」：原样抛给 main 那段统一处理（用法错误 + usage + 3）。
    // 接住它就等于把 `dshc start`（漏主机名）报成退出码 1，脚本会拿去重试（issue #63）
    if (err instanceof UsageError) throw err;
    return reportApiError(err, parsed.flags);
  }
}

async function fetchHosts(port) {
  const res = await apiRequest(port, 'GET', '/api/hosts');
  return res.json.hosts;
}

async function pickHost(port, input) {
  const hosts = await fetchHosts(port);
  const names = hosts.map((h) => h.name);
  const hit = resolveHostArg(input, names);
  if (!hit.ok) {
    errOut(`错误：${hit.error}`);
    if (hit.candidates.length > 0) errOut(`候选：${hit.candidates.join(', ')}`);
    return { ok: false, code: EXIT.usage };
  }
  return { ok: true, name: hit.name, host: hosts.find((h) => h.name === hit.name) };
}

async function cmdLs(parsed) {
  return withApi(parsed, async (port) => {
    const hosts = await fetchHosts(port);
    if (parsed.flags.json) {
      out(JSON.stringify(hosts, null, 2));
      return EXIT.ok;
    }
    if (hosts.length === 0) {
      out('没有主机：检查 ~/.ssh/config 是否有可用 Host 条目。');
      return EXIT.ok;
    }
    out(formatTable(
      ['主机', '状态', '本机映射', 'PID', '版本', '自启'],
      hosts.map((h) => [
        h.name,
        // 挡下的主机 phase 停在最后一次探测的结果，不标一下会让人以为它还在被照看
        h.blocked ? `已屏蔽（${h.blocked.pattern}）` : (PHASE_LABEL[h.phase] ?? h.phase),
        h.mappedUrl ? `127.0.0.1:${h.tunnel.localPort}` : '—',
        h.web ? `${h.web.pid}${h.web.startedByUs ? '' : '(手动)'}` : '—',
        h.probe?.version ?? '—',
        h.config.autoStart ? '是' : '否',
      ]),
    ));
    return EXIT.ok;
  });
}

async function cmdCleanup(parsed) {
  return withApi(parsed, async (port) => {
    const hosts = await fetchHosts(port);
    let selectedHosts = hosts;
    if (parsed.positionals.length > 0) {
      const picked = resolveHostArg(parsed.positionals[0], hosts.map((host) => host.name));
      if (!picked.ok) {
        errOut(`错误：${picked.error}`);
        if (picked.candidates.length > 0) errOut(`候选：${picked.candidates.join(', ')}`);
        return EXIT.usage;
      }
      selectedHosts = hosts.filter((host) => host.name === picked.name);
    }
    const config = (await apiRequest(port, 'GET', '/api/config')).json;
    const configuredRules = parsed.flags.rules === undefined
      ? config.cleanup?.rules ?? DEFAULT_CLEANUP_RULES
      : parsed.flags.rules.split(',');
    let rules;
    try {
      rules = normalizeCleanupRules(configuredRules);
    } catch (error) {
      throw new UsageError(`清理规则无效：${error.message}`);
    }
    const plan = buildCleanupPlan(selectedHosts, { rules });
    if (parsed.flags.json) out(JSON.stringify({
      apply: parsed.flags.apply === true,
      rules,
      candidates: plan,
    }, null, 2));
    else if (plan.length === 0) out('没有符合安全清理规则的实例。');
    else plan.forEach((item) => out(
      `${parsed.flags.apply === true ? '准备清理' : '待清理'} ${item.host} `
      + `pid=${item.pid} port=${item.port ?? 'unknown'} rule=${item.rule} `
      + `fingerprint=${item.fingerprintSha12}`,
    ));
    if (parsed.flags.apply !== true) return EXIT.ok;
    for (const item of plan) {
      const code = await runAction(port, item.host, 'stop', { flags: {} });
      if (code !== EXIT.ok) return code;
    }
    return EXIT.ok;
  });
}

async function cmdProbe(parsed) {
  return withApi(parsed, async (port) => {
    if (parsed.positionals.length === 0) {
      await apiRequest(port, 'POST', '/api/hosts/probe');
      out('已触发全量探测（dshc ls 查看结果）。');
      return EXIT.ok;
    }
    const picked = await pickHost(port, parsed.positionals[0]);
    if (!picked.ok) return picked.code;
    const code = await runAction(port, picked.name, 'probe', parsed);
    if (code === EXIT.ok) {
      const host = (await fetchHosts(port)).find((item) => item.name === picked.name);
      for (const line of installGuideLines(host)) out(line);
    }
    return code;
  });
}

async function cmdHostAction(action, parsed) {
  return withApi(parsed, async (port) => {
    const input = parsed.positionals[0];
    if (!input) throw new UsageError(`dshc ${action} <host>`);
    const picked = await pickHost(port, input);
    if (!picked.ok) return picked.code;
    try {
      return await runAction(port, picked.name, action, parsed);
    } catch (err) {
      if (
        action === 'start'
        && err?.code === 'ADOPTION_AVAILABLE'
        && parsed.flags.adopt !== true
        && parsed.flags['force-new'] !== true
      ) {
        if (!process.stdin.isTTY) {
          errOut('已发现正在运行的手动 dsh web；非交互模式拒绝重复拉起。');
          errOut(`  ${err.message}`);
          errOut('请使用 --adopt（多个实例时加 --pid <pid> 指定领养谁）或 --force-new。');
          return EXIT.failed;
        }
        // 候选清单就在这条错误里（pid=… port=…），先摆出来再问，否则用户无从选起
        errOut(err.message);
        const choice = await promptAdoption(picked.name);
        if (choice === 'adopt' || Number.isInteger(choice)) {
          return runAction(port, picked.name, 'start', {
            ...parsed,
            flags: {
              ...parsed.flags,
              adopt: true,
              ...(Number.isInteger(choice) ? { pid: choice } : {}),
            },
          });
        }
        if (choice === 'force') {
          return runAction(port, picked.name, 'start', {
            ...parsed,
            flags: { ...parsed.flags, 'force-new': true },
          });
        }
        return EXIT.failed;
      }
      if (action === 'start') {
        const current = await fetchHosts(port).catch(() => []);
        const host = current.find((item) => item.name === picked.name);
        for (const line of installGuideLines(host, { full: false })) errOut(line);
      }
      throw err;
    }
  });
}

/** @returns {Promise<'adopt'|'force'|'cancel'|number>} number = 要领养的 PID */
function promptAdoption(host) {
  return new Promise((resolve) => {
    const input = process.stdin;
    const output = process.stdout;
    const rl = readline.createInterface({ input, output });
    rl.question(
      `主机 ${host} 已有手动 dsh web：[a] 只读领养 / [f] 强拉新实例 / [c] 取消 / 或直接输入要领养的 PID？ `,
      (answer) => {
        rl.close();
        resolve(parseAdoptionAnswer(answer));
      },
    );
  });
}

/** `a` / `f` / `c` 之外还认裸 PID：多实例时 `a` 会被后端以「请指定 PID」挡回。 */
export function parseAdoptionAnswer(answer) {
  const choice = String(answer ?? '').trim().toLowerCase();
  if (/^\d+$/.test(choice)) {
    const pid = Number(choice);
    return pid >= 1 && pid <= 4_294_967_295 ? pid : 'cancel';
  }
  return choice === 'a' ? 'adopt' : choice === 'f' ? 'force' : 'cancel';
}

/** 202 受理型操作：默认挂 SSE 等终态，--no-wait 立即返回。 */
async function runAction(port, name, action, parsed) {
  const adopt = action === 'start' && parsed.flags.adopt === true;
  const endpoint = `/api/hosts/${encodeURIComponent(name)}/${adopt ? 'adopt' : action}`;
  const terminalAction = adopt ? 'adopt' : action;
  // 一台主机上不止一个手动实例时，后端拒绝替用户猜：--pid 是唯一的指定方式
  const body = adopt
    ? (Number.isInteger(parsed.flags.pid) ? { pid: parsed.flags.pid } : {})
    : action === 'start' && parsed.flags['force-new'] === true
      ? { forceNew: true }
      : undefined;

  if (parsed.flags['no-wait']) {
    await apiRequest(port, 'POST', endpoint, body);
    out(`已受理：${name} ${action}`);
    return EXIT.ok;
  }

  const res = await waitTerminal(port, name, terminalAction, {
    trigger: () => apiRequest(port, 'POST', endpoint, body),
    onLog: (line) => errOut(`  [${line.level}] ${line.msg}`),
  });

  if (res.status === 'ok') {
    out(`${name} ${action} 成功${res.phase ? `（${PHASE_LABEL[res.phase] ?? res.phase}）` : ''}`);
    return EXIT.ok;
  }
  if (res.status === 'interrupted') {
    errOut(`不等了（Ctrl-C）。${name} ${action} 仍在 manager 那边继续，dshc ls 看它落到哪。`);
    return EXIT.interrupted;
  }
  if (res.status === 'timeout') {
    errOut(`${name} ${action} 等待超时；manager 可能仍在执行，dshc ls 查看当前状态。`);
    return EXIT.comm;
  }
  errOut(`${name} ${action} 失败${res.phase ? `（回到${PHASE_LABEL[res.phase] ?? res.phase}）` : ''}${res.lastError ? `：${res.lastError}` : ''}`);
  return EXIT.failed;
}

async function cmdLog(parsed) {
  return withApi(parsed, async (port) => {
    const input = parsed.positionals[0];
    if (!input) throw new UsageError('dshc log <host> [-n N]');
    const picked = await pickHost(port, input);
    if (!picked.ok) return picked.code;
    const lines = parsed.flags.n ?? 200;
    const res = await apiRequest(port, 'GET', `/api/hosts/${encodeURIComponent(picked.name)}/log?lines=${lines}`);
    process.stdout.write(res.text.endsWith('\n') || res.text === '' ? res.text : `${res.text}\n`);
    return EXIT.ok;
  });
}

async function cmdOpen(parsed) {
  const port = managerPort(parsed.flags);
  const input = parsed.positionals[0];
  let url = `http://127.0.0.1:${port}/`;
  if (input) {
    try {
      const hosts = await fetchHosts(port);
      const hit = resolveHostArg(input, hosts.map((h) => h.name));
      if (!hit.ok) {
        errOut(`错误：${hit.error}`);
        if (hit.candidates.length > 0) errOut(`候选：${hit.candidates.join(', ')}`);
        return EXIT.usage;
      }
      url = `http://127.0.0.1:${port}/#/host/${encodeURIComponent(hit.name)}`;
    } catch (err) {
      return reportApiError(err, parsed.flags);
    }
  }
  out(url);
  const opener = openerBin();
  const child = spawn(opener.bin, [...opener.prefixArgs, url], { stdio: 'ignore', detached: true });
  child.unref();
  return EXIT.ok;
}

/** dshc config get|set <点路径> [值]：走 API 让运行中的实例热生效。 */
async function cmdConfig(parsed) {
  const [sub, key, value] = parsed.positionals;
  if (!['get', 'set'].includes(sub)) throw new UsageError('dshc config get|set <key> [value]');

  if (sub === 'get') {
    const cfg = readConfigFile();
    if (!cfg) {
      errOut('尚未初始化 config.json，先跑 dshc init。');
      return EXIT.failed;
    }
    const found = key ? getByPath(cfg, key) : cfg;
    if (found === undefined) {
      errOut(`config 里没有 ${key}`);
      return EXIT.failed;
    }
    out(typeof found === 'object' ? JSON.stringify(found, null, 2) : String(found));
    return EXIT.ok;
  }

  if (!key || value === undefined) throw new UsageError('dshc config set <key> <value>');

  return withApi(parsed, async (port) => {
    const parsedValue = coerceConfigValue(value);

    // 主机级键走 PUT /api/hosts/:name/config（CLI 镜像全部主机操作，02 §10）
    const hostPatch = buildHostPatchFor(key, parsedValue);
    if (hostPatch) {
      const picked = await pickHost(port, hostPatch.name);
      if (!picked.ok) return picked.code;
      await apiRequest(port, 'PUT', `/api/hosts/${encodeURIComponent(picked.name)}/config`, hostPatch.body);
      const [field, written] = Object.entries(hostPatch.body)[0];
      out(`已写入 hosts.${picked.name}.${field} = ${JSON.stringify(written)}`);
      out('下次拉起时生效（正在跑的实例不受影响）：dshc restart <host>');
      return EXIT.ok;
    }

    const body = buildDefaultsPatchFor(key, parsedValue);
    if (!body) {
      errOut(`不支持直接 set ${key}；可写：manager.port、defaults.remoteWebPort、defaults.localPortRange、defaults.hostFilter.deny、defaults.hostFilter.allow、hosts.<主机>.workdir`);
      return EXIT.usage;
    }
    const res = await apiRequest(port, 'PUT', '/api/config/defaults', body);
    out(`已写入 ${key} = ${JSON.stringify(parsedValue)}`);
    if (res.json?.restartRequired) out('manager 端口改动需重启后生效：dshc restart');
    return EXIT.ok;
  });
}

export function coerceConfigValue(raw) {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === 'true' || raw === 'false') return raw === 'true';
  const range = /^(\d+)[-,\s]+(\d+)$/.exec(raw);
  if (range) return [Number(range[1]), Number(range[2])];
  return raw;
}

/**
 * `hosts.<主机>.<字段>` 点路径 → PUT 主机配置的 {主机名, 请求体}。
 * 主机名本身可含点（ssh Host 名允许），故用贪婪匹配 + 已知字段后缀切分。
 * @returns {{name:string, body:object}|null} null = 不是主机级键
 */
export function buildHostPatchFor(key, value) {
  const m = /^hosts\.(.+)\.workdir$/.exec(String(key ?? ''));
  if (!m || m[1] === '') return null;
  // 命令行没法直接给 JSON null，故约定空串与字面 null 都表示「回落远端家目录」
  const wd = value === '' || value === 'null' ? null : value;
  return { name: m[1], body: { workdir: wd } };
}

export function buildDefaultsPatchFor(key, value) {
  if (key === 'manager.port') return { manager: { port: value } };
  if (key === 'defaults.remoteWebPort') return { remoteWebPort: value };
  if (key === 'defaults.localPortRange') return { localPortRange: value };
  if (key === 'defaults.hostFilter.deny') return { hostFilter: { deny: parsePatternList(value) } };
  if (key === 'defaults.hostFilter.allow') return { hostFilter: { allow: parsePatternList(value) } };
  return null;
}

/**
 * 名单是「一串正则」，命令行只有一个 value，故约定逗号分隔；空串/none = 清空这一份名单。
 * 正则里逗号极罕见（`a{1,2}` 才用得上），需要时改页面或直接编辑 config.json。
 */
export function parsePatternList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v));
  const raw = String(value ?? '').trim();
  if (raw === '' || raw === 'none' || raw === 'null') return [];
  return raw.split(',').map((v) => v.trim()).filter((v) => v !== '');
}

// ── dshc init（ENG-18） ─────────────────────────────────────────────────

/**
 * 给候选清单稳定地补一台本机。强制重配时复用已有 local；名字冲突才追加 `-local[-N]`。
 * @param {Array<string|{name:string,local?:boolean}>} candidates
 * @param {string} hostname
 * @param {object|null} current
 */
export function withLocalCandidate(candidates, hostname, current = null) {
  const normalized = normalizeHostCandidates(candidates);
  const localName = canonicalSetupLocalName(hostname, {
    hosts: current?.hosts,
    sshNames: normalized.filter((candidate) => !candidate.local).map((candidate) => candidate.name),
  });

  return [
    ...normalized.filter((candidate) => !candidate.local && candidate.name !== localName),
    { name: localName, local: true },
  ];
}

async function cmdInit({ flags }) {
  const verdict = classifyConfigFile();
  if (verdict.kind === 'unreadable') return reportBadConfig(verdict);
  if (verdict.kind === 'damaged' && !flags.force) {
    errOut(`${resolvePaths().config} 已损坏（${verdict.reason}）。`);
    errOut('要丢掉它重走向导请加 --force（会先备份成 config.json.bad-<时间戳>）。');
    return EXIT.usage;
  }

  const existing = verdict.kind === 'ok' ? verdict.config : null;
  if (existing?.setupCompleted === true && !flags.force) {
    errOut('配置已初始化。要重走向导请加 --force（会预填现有值）。');
    return EXIT.usage;
  }
  if (!process.stdin.isTTY) {
    errOut('dshc init 需要交互终端。非交互场景请用页面向导或直接写 config.json。');
    return EXIT.usage;
  }
  if (verdict.kind === 'damaged') {
    const saved = backupDamagedConfig();
    if (saved) out(`原配置已损坏，先备份到 ${saved}`);
  }

  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const { loadHosts } = await import('./ssh-config.js');
    const { probeOnce } = await import('./prober.js');
    const preferredLocalName = os.hostname();
    const { compileHostFilter, hostFilterReason } = await import('./lib/host-filter.js');
    // 向导跑在 manager 之前，名单只能自己从（已有或出厂）配置里取
    const filter = compileHostFilter(
      existing?.defaults?.hostFilter ?? FACTORY_DEFAULTS.defaults.hostFilter,
    );
    const discovered = loadHosts().map((host) => host.name);
    const sshNames = [];
    for (const name of discovered) {
      const verdict = filter.match(name);
      if (verdict) out(`跳过 ${name}：${hostFilterReason(verdict)}`);
      else sshNames.push(name);
    }
    const candidates = withLocalCandidate(
      sshNames,
      preferredLocalName,
      existing,
    );

    const result = await runSetupWizard({
      ask: (prompt) => rl.question(prompt),
      current: existing?.setupCompleted ? existing : newFactoryConfig(),
      sshHosts: candidates,
      probeHost: (name, candidate) => probeOnce(name, { local: candidate.local, timeoutMs: 20_000 }),
    });
    if (!result) {
      out('已取消，未写入任何内容。');
      return EXIT.ok;
    }
    return persistSetup(result.config, flags, {
      current: existing,
      sshNames,
      preferredLocalName,
    });
  } finally {
    rl.close();
  }
}

/**
 * 四步向导本体（ENG-18）。把 IO 全收进 `ask`/`print` 两个注入点，
 * 才能让单测脚本化地走完整条路径——终端交互否则只能靠人肉走查。
 *
 * @param {{
 *   ask: (prompt: string) => Promise<string>,
 *   print?: (line?: string) => void,
 *   current: object,
 *   sshHosts?: Array<string|{name:string,local?:boolean}>,
 *   probeHost?: ((name: string, candidate:{name:string,local:boolean}) => Promise<{phase:string}>) | null,
 *   probeDeadlineMs?: number,
 * }} io
 * @returns {Promise<{config:object, answers:object, selection:object, probeResults:object}|null>}
 *   null = 用户在确认步骤放弃
 */
export async function runSetupWizard({
  ask, print = out, current, sshHosts = [], probeHost = null, probeDeadlineMs = 25_000,
}) {
  const answers = defaultAnswers(current);
  const candidates = normalizeHostCandidates(sshHosts);

  print('');
  print('DSH Center 初始化向导（回车即取方括号内的默认值）');

  // 步骤 1–2：逐字段问答
  for (const step of SETUP_STEPS.filter((s) => s.fields)) {
    print('');
    print(`— ${step.title} —`);
    for (const f of step.fields) {
      // eslint-disable-next-line no-await-in-loop -- 交互问答天然串行
      await askField({ ask, print }, f, answers);
    }
  }

  // 步骤 3：主机纳管与开启（探测并行，先回先显）
  const probeResults = {};
  print('');
  print('— 主机纳管与开启 —');
  if (candidates.length === 0) {
    print('~/.ssh/config 里没有可用主机，可稍后补充后重跑 dshc init --force。');
  } else if (probeHost) {
    print(`发现 ${candidates.length} 台候选主机，正在并行探测…`);
    const probing = Promise.all(candidates.map(async (candidate) => {
      const { name } = candidate;
      try {
        const r = await probeHost(name, candidate);
        probeResults[name] = r;
        print(`  ${r.phase === 'ready' ? '✔' : '✘'} ${name}${candidate.local ? '（本机）' : ''}：${PHASE_LABEL[r.phase] ?? r.phase}`);
        if (r.phase === 'no_dsh') {
          print(`    查看安装指引：dshc probe ${name}`);
        }
      } catch (err) {
        probeResults[name] = { phase: 'unreachable' };
        print(`  ✘ ${name}${candidate.local ? '（本机）' : ''}：探测失败（${err.message}）`);
      }
    }));
    // 探测慢的主机不该卡住向导：给它一个上限，超时的按未完成处理
    await raceWithDeadline(probing, probeDeadlineMs);
  }

  const selection = await askSelection({ ask, print }, candidates, probeResults);

  // 步骤 4：预览 + 确认
  // 本机身份不是普通的 disabled SSH 条目：用户明确“不纳管”就不提交 local:true，
  // 因而最终确认后也不会为了一个未选择的候选去提前创建本机身份。
  const selectedCandidates = candidates.filter(
    (candidate) => !candidate.local || selection[candidate.name]?.enabled !== false,
  );
  const config = buildConfigFromAnswers(answers, selectedCandidates, probeResults, FACTORY_DEFAULTS, { selection });
  print('');
  print('— 确认 —');
  print(previewJson(config));
  const pending = candidates.filter(({ name }) => !probeResults[name]).length;
  if (pending > 0) print(`仍有 ${pending} 台探测未完成：它们按当前纳管选择保存，自启一律关闭。`);
  const yes = await ask('写入配置？[Y/n] > ');
  if (/^n/i.test(yes.trim())) return null;

  return { config, answers, selection, probeResults };
}

async function askField({ ask, print }, field, answers) {
  const current = getByPath(answers, field.key);
  const shown = field.format ? field.format(current) : String(current);
  for (;;) {
    if (field.hint) print(`  （${field.hint}）`);
    // eslint-disable-next-line no-await-in-loop -- 校验失败要重问
    const raw = await ask(`${field.label} [${shown}] > `);
    if (raw.trim() === '') return current;

    const parsed = field.parse(raw);
    if (!parsed.ok) {
      print(`  ✘ ${parsed.error}`);
      continue;
    }
    const bad = field.validate(parsed.value);
    if (bad) {
      print(`  ✘ ${bad}`);
      continue;
    }
    setByPath(answers, field.key, parsed.value);
    return parsed.value;
  }
}

/** 默认全部纳管；开启链接默认勾选全部 ready（其余不允许勾）。 */
async function askSelection({ ask, print }, candidates, probeResults) {
  const selection = {};
  for (const { name } of candidates) selection[name] = { enabled: true, autoStart: probeResults[name]?.phase === 'ready' };
  if (candidates.length === 0) return selection;

  const listed = candidates.map((candidate, i) => `${i + 1}) ${candidate.name}${candidate.local ? '（本机）' : ''}`).join('  ');
  print(`  ${listed}`);
  const skip = await ask('不纳管哪些？输入序号，逗号分隔（回车＝全部纳管） > ');
  for (const token of skip.split(/[\s,]+/).filter(Boolean)) {
    const idx = Number(token) - 1;
    const name = candidates[idx]?.name;
    if (name) selection[name] = { enabled: false, autoStart: false };
  }

  const readyHosts = candidates
    .map((candidate) => candidate.name)
    .filter((name) => selection[name].enabled && probeResults[name]?.phase === 'ready');
  if (readyHosts.length > 0) {
    print(`  可随 manager 自启（仅 ready）：${readyHosts.map((n, i) => `${i + 1}) ${n}`).join('  ')}`);
    const off = await ask('不自启哪些？输入序号（回车＝全部自启） > ');
    for (const token of off.split(/[\s,]+/).filter(Boolean)) {
      const name = readyHosts[Number(token) - 1];
      if (name) selection[name].autoStart = false;
    }
  }
  return selection;
}

/**
 * CLI 侧与 server.assertSetupLocalIdentities 等价的可信来源判定。
 * 只认现有 local 或共享纯算法算出的 canonical local；SSH 名即使同名也优先拒绝。
 */
export function assertCliSetupLocalIdentities(config, {
  current = null, preferredLocalName, sshNames = [],
} = {}) {
  const currentHosts = current?.hosts ?? {};
  const ssh = new Set(sshNames);
  const canonicalLocal = canonicalSetupLocalName(preferredLocalName, {
    hosts: currentHosts,
    sshNames,
  });
  for (const [name, host] of Object.entries(config?.hosts ?? {})) {
    const existingLocal = currentHosts[name]?.local === true;
    const requestedLocal = host?.local === true;
    const existingRemote = (Object.hasOwn(currentHosts, name) && !existingLocal) || ssh.has(name);
    const trustedCandidate = name === canonicalLocal;

    if (requestedLocal && (existingRemote || (!existingLocal && !trustedCandidate))) {
      const message = existingRemote
        ? `初始化配置不能把 SSH 主机 ${name} 改成本机`
        : `初始化配置不能把未经 CLI 认可的主机 ${name} 声明为本机`;
      throw new DshError('NOT_ALLOWED', message, { host: name });
    }
    if (!requestedLocal && existingLocal) {
      throw new DshError('NOT_ALLOWED', `初始化配置不能把本机主机 ${name} 改成 SSH 主机`, {
        host: name,
      });
    }
  }
  return config;
}

/** server 在跑 → 单次 POST /api/setup；没在跑 → 本进程做等价身份校验后原子写盘。 */
export async function persistSetup(config, flags = {}, {
  current = null,
  sshNames = [],
  preferredLocalName = os.hostname(),
} = {}) {
  try {
    assertCliSetupLocalIdentities(config, { current, preferredLocalName, sshNames });
  } catch (err) {
    return reportApiError(err, flags);
  }

  const check = await daemon.aliveCheck();
  if (check.alive) {
    try {
      const port = check.info.port;
      const res = await apiRequest(port, 'POST', '/api/setup', config);
      out('配置已提交给运行中的 manager。');
      if (res.json?.portChanged) out(`端口已改为 ${res.json.port}，${res.json.restarting ? 'manager 正在自我重启' : '需要 dshc restart 生效'}。`);
      return EXIT.ok;
    } catch (err) {
      return reportApiError(err, flags);
    }
  }

  const store = await import('./store.js');
  await store.init();
  try {
    store.assertSetupLocalIdentities(config, preferredLocalName, sshNames);
    store.saveConfigFromSetup(config);
  } catch (err) {
    errOut(`错误：${err.message}`);
    if (err.detail) errOut(err.detail);
    return EXIT.failed;
  }
  out(`已写入 ${resolvePaths().config}。执行 dshc up 启动 manager。`);
  return EXIT.ok;
}

/** 到点就放行，但赢家出现后要清掉定时器——否则 CLI 白等到超时才退出。 */
function raceWithDeadline(promise, ms) {
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// ── 命令表与分发 ─────────────────────────────────────────────────────────

export const COMMANDS = {
  init: { usage: 'dshc init [--force]', needsServer: false, run: cmdInit },
  up: { usage: 'dshc up [--port N] [--foreground]', needsServer: false, run: cmdUp },
  down: { usage: 'dshc down', needsServer: false, run: cmdDown },
  restart: { usage: 'dshc restart [<host>]', needsServer: false, run: cmdRestart },
  status: { usage: 'dshc status [--json]', needsServer: false, run: cmdStatus },
  logs: { usage: 'dshc logs [-f] [-n N]', needsServer: false, run: cmdLogs },
  service: { usage: 'dshc service install|uninstall|status', needsServer: false, run: cmdService },
  version: { usage: 'dshc version [--json]', needsServer: false, run: cmdVersion },
  update: { usage: 'dshc update [--pre] [--ref <分支|tag>] [--restart]', needsServer: false, run: cmdUpdate },

  ls: { usage: 'dshc ls [--json]', needsServer: true, run: cmdLs },
  probe: { usage: 'dshc probe [<host>]', needsServer: true, run: cmdProbe },
  start: { usage: 'dshc start <host> [--adopt [--pid <pid>]|--force-new] [--no-wait]', needsServer: true, run: (p) => cmdHostAction('start', p) },
  stop: { usage: 'dshc stop <host> [--no-wait]', needsServer: true, run: (p) => cmdHostAction('stop', p) },
  reconnect: { usage: 'dshc reconnect <host> [--no-wait]', needsServer: true, run: (p) => cmdHostAction('reconnect', p) },
  cleanup: { usage: 'dshc cleanup [<host>] [--rules LIST] [--apply] [--json]', needsServer: true, run: cmdCleanup },
  log: { usage: 'dshc log <host> [-n N]', needsServer: true, run: cmdLog },
  // 先探活再开浏览器：manager 没起时打开一个必定打不开的页面，还报成功，
  // 只会让人去怀疑浏览器和端口（issue #23）。引导模式要放行，页面就是向导。
  open: { usage: 'dshc open [<host>]', needsServer: true, allowSetupMode: true, run: cmdOpen },
  config: { usage: 'dshc config get|set <key> [value]', needsServer: false, run: cmdConfig },
};

export function usageText() {
  const lines = ['dshc —— DSH Center 本机入口', '', '生命周期：'];
  for (const key of ['init', 'up', 'down', 'restart', 'status', 'logs', 'service', 'version', 'update']) lines.push(`  ${COMMANDS[key].usage}`);
  lines.push('', '主机操作：');
  for (const key of ['ls', 'probe', 'start', 'stop', 'reconnect', 'cleanup', 'log', 'open', 'config']) lines.push(`  ${COMMANDS[key].usage}`);
  lines.push('', '退出码：0 成功｜1 操作失败｜2 超时/通信失败｜3 用法错误｜130 等待被 Ctrl-C 打断（操作仍在继续）');
  return lines.join('\n');
}

/**
 * @param {string[]} argv 不含 node 与脚本路径
 * @returns {Promise<number>} 退出码
 */
export async function run(argv) {
  const [rawName, ...rest] = argv;
  if (!rawName || rawName === '-h' || rawName === '--help' || rawName === 'help') {
    out(usageText());
    return rawName ? EXIT.ok : EXIT.usage;
  }

  // `--help`/`-h` 收而 `--version` 不收，说不过去：排查现场问「你装的哪版」，
  // 第一反应就是敲 `--version`（issue #98）。`-v` 留着不占——`--verbose` 迟早要个短名。
  const name = rawName === '--version' || rawName === '-V' ? 'version' : rawName;

  const cmd = COMMANDS[name];
  if (!cmd) {
    errOut(`未知命令：${name}`);
    errOut(usageText());
    return EXIT.usage;
  }

  let parsed;
  try {
    parsed = parseArgv(rest);
  } catch (err) {
    errOut(`用法错误：${err.message}`);
    errOut(cmd.usage);
    return EXIT.usage;
  }

  // 需要 manager 的命令先探活：不做隐式自动拉起（02 §10）
  if (cmd.needsServer) {
    const port = managerPort(parsed.flags);
    const info = await daemon.fetchInfo(port);
    if (!info) {
      errOut(managerDownMessage(port));
      return EXIT.comm;
    }
    // open 是引导模式下唯一还该放行的命令——页面就是向导本身，拦住它等于把人锁在门外
    if (info.setupCompleted === false && !cmd.allowSetupMode) {
      errOut('manager 处于首启引导模式（配置未完成）。先执行 dshc init 或打开管理台完成配置。');
      return EXIT.failed;
    }
  }

  try {
    return await cmd.run(parsed);
  } catch (err) {
    if (err instanceof UsageError) {
      errOut(`用法错误：${err.message}`);
      errOut(cmd.usage);
      return EXIT.usage;
    }
    return reportApiError(err, parsed.flags);
  }
}

// 必须比真实路径：装到 PATH 用的是软链（npm link 同理），argv[1] 是链接名而
// import.meta.url 已经是解引用后的真身，只比字面量会判成「被 import」而什么都不做
const invokedDirectly = isMainEntry(import.meta.url);

if (invokedDirectly) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      errOut(`内部错误：${err.stack ?? err.message}`);
      process.exitCode = EXIT.failed;
    });
}
