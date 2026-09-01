/**
 * On-demand fleet analysis.
 *
 * This module deliberately keeps reports in memory only. It invokes trusted
 * executables with argv (never a shell), bounds both output and runtime, and
 * treats semantic DSH output as optional: deterministic Sidecar clusters are
 * still useful when the local model is unavailable.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { monotonicMs } from './lib/clock.js';

export const MIN_SIDECAR_VERSION = '0.9.0';
export const ANALYSIS_TIMEOUT_MS = 90_000;
export const ANALYSIS_OUTPUT_LIMIT = 4 * 1024 * 1024;
export const ANALYSIS_CACHE_TTL_MS = 5 * 60_000;
export const ANALYSIS_MAX_GROUPS = 100;
export const ANALYSIS_RULES = Object.freeze([
  'largest', 'recent', 'agent', 'model', 'workspace', 'max-groups',
]);

function parseVersion(text) {
  const match = String(text ?? '').match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function isCompatibleVersion(actual, minimum = MIN_SIDECAR_VERSION) {
  const a = parseVersion(actual);
  const b = parseVersion(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

function redacted(value, limit = 1_024) {
  return String(value ?? '')
    .replace(/(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{8,}/gu, '[secret]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[email]')
    .replace(/(?:\/Users\/|\/home\/|\/tmp\/|[A-Za-z]:\\)[^\s,)]+/gu, '[path]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);
}

export function selectAnalysisRows(rows, {
  rules = ['largest', 'recent'],
  maxGroups = ANALYSIS_MAX_GROUPS,
} = {}) {
  const selectedRules = [...new Set(rules.map((rule) => String(rule).trim().toLowerCase()))]
    .filter(Boolean);
  if (selectedRules.some((rule) => !ANALYSIS_RULES.includes(rule))) {
    throw new Error('unknown analysis rule');
  }
  if (!Number.isInteger(maxGroups) || maxGroups < 1 || maxGroups > 10_000) {
    throw new Error('analysis maxGroups is out of bounds');
  }
  const cap = selectedRules.includes('max-groups')
    ? Math.min(maxGroups, ANALYSIS_MAX_GROUPS)
    : maxGroups;
  const values = rows.filter((row) => row && typeof row === 'object').slice();
  const key = (row, rule) => {
    if (rule === 'largest') return -(Number.isFinite(row.count) ? row.count : 0);
    if (rule === 'recent') return -(Number.isFinite(row.time_bucket) ? row.time_bucket : 0);
    if (rule === 'agent') return String(row.agent ?? '').toLowerCase();
    if (rule === 'model') return String(row.model ?? '').toLowerCase();
    if (rule === 'workspace') return String(row.project ?? '').toLowerCase();
    return '';
  };
  const priorities = selectedRules.length > 0 ? selectedRules : ['largest', 'recent'];
  values.sort((left, right) => {
    for (const rule of priorities) {
      const a = key(left, rule);
      const b = key(right, rule);
      if (a < b) return -1;
      if (a > b) return 1;
    }
    return String(left.cluster_id ?? '').localeCompare(String(right.cluster_id ?? ''));
  });
  return values.slice(0, cap);
}

function runBounded(file, args, {
  cwd = process.cwd(),
  timeoutMs = ANALYSIS_TIMEOUT_MS,
  outputLimit = ANALYSIS_OUTPUT_LIMIT,
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawnImpl(file, args, {
        cwd,
        env: { ...process.env, NO_COLOR: '1' },
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ ok: false, code: 'spawn_failed', detail: redacted(error?.message) });
      return;
    }
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // The process may have exited between the timeout and the kill.
      }
    };
    const append = (part, stream) => {
      const target = stream === 'stdout' ? stdout : stderr;
      if (settled) return;
      const next = `${target}${part}`;
      if (next.length > outputLimit) {
        kill();
        finish({ ok: false, code: 'output_limit', detail: '分析命令输出超过上限' });
        return;
      }
      if (stream === 'stdout') stdout = next;
      else stderr = next;
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (part) => append(String(part), 'stdout'));
    child.stderr?.on('data', (part) => append(String(part), 'stderr'));
    child.once('error', (error) => finish({ ok: false, code: 'spawn_failed', detail: redacted(error?.message) }));
    child.once('close', (code, signal) => finish({
      ok: code === 0,
      code: code === 0 ? null : signal ? 'terminated' : 'command_failed',
      exitCode: code,
      stdout,
      detail: code === 0 ? null : redacted(stderr) || `命令退出码 ${code ?? 'unknown'}`,
    }));
    timer = setTimeout(() => {
      kill();
      finish({ ok: false, code: 'timeout', detail: '分析命令超时' });
    }, timeoutMs);
    timer.unref?.();
  });
}

function executableCandidates(env, name) {
  const configured = name === 'sidecar' ? env.AGENT_SIDECAR_BIN : env.DSH_BIN;
  return [
    configured,
    path.join(os.homedir(), '.local', 'bin', name === 'sidecar' ? 'agent-sidecar' : 'dsh'),
    name === 'sidecar' ? 'agent-sidecar' : 'dsh',
  ].filter(Boolean);
}

export function createAnalysisService({
  env = process.env,
  spawnImpl = spawn,
  now = monotonicMs,
  cacheTtlMs = ANALYSIS_CACHE_TTL_MS,
} = {}) {
  let cache = null;
  let inFlight = null;

  async function status() {
    for (const executable of executableCandidates(env, 'sidecar')) {
      const result = await runBounded(executable, ['--version'], { spawnImpl, timeoutMs: 10_000 });
      if (!result.ok) continue;
      const version = parseVersion(result.stdout);
      if (!version) continue;
      const versionText = `${version[0]}.${version[1]}.${version[2]}`;
      return {
        executable,
        version: versionText,
        minimumVersion: MIN_SIDECAR_VERSION,
        compatible: isCompatibleVersion(versionText),
        daemon: 'unknown',
        service: 'unknown',
      };
    }
    return {
      executable: null,
      version: null,
      minimumVersion: MIN_SIDECAR_VERSION,
      compatible: false,
      daemon: 'unknown',
      service: 'unknown',
    };
  }

  async function analyze() {
    if (cache && now() - cache.generatedAt < cacheTtlMs) return { ...cache.value, cached: true };
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const sidecar = await status();
      if (!sidecar.compatible || !sidecar.executable) {
        return {
          generatedAt: new Date().toISOString(), // 墙钟：报告展示时间戳。
          cached: false,
          clusters: [],
          partial: true,
          failures: [{
            source: 'sidecar',
            code: sidecar.executable ? 'version_incompatible' : 'unavailable',
            detail: sidecar.executable
              ? `agent-sidecar 版本低于 ${MIN_SIDECAR_VERSION}`
              : '未找到 agent-sidecar',
          }],
          report: null,
          sidecar,
        };
      }
      const clusterResult = await runBounded(
        sidecar.executable,
        ['cluster', '--remote', '--json', '--all'],
        { spawnImpl },
      );
      let clusters = [];
      let parseFailure = null;
      if (clusterResult.ok) {
        try {
          const parsed = JSON.parse(clusterResult.stdout);
          clusters = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : [];
        } catch {
          parseFailure = { source: 'sidecar', code: 'malformed_json', detail: '聚类命令返回了无法解析的 JSON' };
        }
      }
      const failures = [];
      if (!clusterResult.ok) failures.push({
        source: 'sidecar',
        code: clusterResult.code,
        detail: clusterResult.detail,
      });
      if (parseFailure) failures.push(parseFailure);
      const reportInput = JSON.stringify(selectAnalysisRows(clusters).map((row) => ({
        project: redacted(row.project, 160),
        agent: redacted(row.agent, 80),
        model: redacted(row.model, 120),
        model_provider: redacted(row.model_provider, 120),
        count: row.count,
        time_bucket: row.time_bucket,
        hosts: Array.isArray(row.hosts) ? row.hosts.map((host) => redacted(host, 80)) : [],
      })));
      let report = null;
      for (const executable of executableCandidates(env, 'dsh')) {
        const semantic = await runBounded(
          executable,
          ['--profile', 'headless', `根据以下脱敏聚类元数据，给出不超过三条的中文摘要；不要猜测缺失字段：${reportInput}`],
          { spawnImpl, timeoutMs: 60_000 },
        );
        if (semantic.ok && redacted(semantic.stdout, 4_000)) {
          report = redacted(semantic.stdout, 4_000);
          break;
        }
        if (semantic.code === 'timeout') {
          failures.push({ source: 'dsh', code: 'timeout', detail: '本机 headless 报告超时，已降级为确定性聚合' });
          break;
        }
      }
      const value = {
        generatedAt: new Date().toISOString(), // 墙钟：报告展示时间戳。
        cached: false,
        clusters,
        partial: failures.length > 0 || report === null,
        failures,
        report,
        sidecar,
      };
      cache = { generatedAt: now(), value };
      return value;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  return { status, analyze };
}

