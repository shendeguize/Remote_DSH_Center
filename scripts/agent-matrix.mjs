#!/usr/bin/env node
/* eslint-disable no-await-in-loop */
/**
 * Five-agent Sidecar/plugin acceptance matrix.
 *
 * The default mode is intentionally real and requires an explicit host.  The
 * fixture mode exercises the orchestration and evidence contract without
 * touching SSH, DSHC_HOME, agent credentials, or a plugin endpoint.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';
import { assertSafeHost } from '../src/lib/shq.js';
import {
  evidenceId, readLatestEvidence, writeEvidence,
} from './lib/acceptance.mjs';
import { rescanSshConfig, Rig } from './real-acceptance.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const AGENTS = Object.freeze(['claude', 'codex', 'copilot', 'kimi', 'dsh']);
export const DEFAULT_PARALLEL = 2;
export const DEFAULT_TIMEOUT_MS = 180_000;
export const MAX_PARALLEL = 5;
export const MAX_TIMEOUT_MS = 15 * 60_000;
const MESSAGE = 'agent-sidecar matrix probe: report readiness';

function integer(value, name, { min, max }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return parsed;
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

export function parseArgs(argv) {
  const out = {
    host: null,
    agents: [...AGENTS],
    parallel: DEFAULT_PARALLEL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    tier: 'full',
    reportDir: path.join(REPO, '.local', 'evidence', 'agent-matrix'),
    remoteDir: '/home/caros/workspace/dsh_debug',
    fixture: false,
    dryRun: false,
    keep: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host') out.host = argv[++i];
    else if (arg === '--agents') out.agents = argv[++i].split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
    else if (arg === '--parallel') out.parallel = integer(argv[++i], '--parallel', { min: 1, max: MAX_PARALLEL });
    else if (arg === '--timeout') out.timeoutMs = integer(argv[++i], '--timeout', { min: 1_000, max: MAX_TIMEOUT_MS });
    else if (arg === '--tier') out.tier = argv[++i];
    else if (arg === '--report-dir') out.reportDir = path.resolve(argv[++i]);
    else if (arg === '--remote-dir') out.remoteDir = absolutePath(argv[++i], '--remote-dir');
    else if (arg === '--fixture') out.fixture = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--keep') out.keep = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!['smoke', 'full'].includes(out.tier)) throw new Error('--tier must be smoke or full');
  if (!out.fixture && !out.dryRun && !out.host) throw new Error('--host is required for real matrix runs');
  if (out.host) assertSafeHost(out.host);
  out.remoteDir = absolutePath(out.remoteDir, '--remote-dir');
  if (!out.agents.length || out.agents.some((agent) => !AGENTS.includes(agent))) {
    throw new Error(`--agents must contain only: ${AGENTS.join(',')}`);
  }
  const unique = new Set(out.agents);
  if (unique.size !== out.agents.length) throw new Error('--agents must not contain duplicates');
  return out;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12);
}

function sessionRowByAgent(rows, agent) {
  return rows
    .filter((row) => row?.agent === agent && typeof row.session_id === 'string' && row.session_id)
    .sort((left, right) => Number(right.updated_at ?? 0) - Number(left.updated_at ?? 0))[0] ?? null;
}

async function fetchJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      headers: { connection: 'close', ...options.headers },
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`invalid JSON response (${response.status})`);
    }
    return { status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function pluginUrl(base, route) {
  return new URL(route, base).toString();
}

async function dshRpc(base, method, payload, timeoutMs) {
  const response = await fetchJson(
    pluginUrl(base, `/api/${method}`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method,
        payload,
      }),
    },
    timeoutMs,
  );
  if (response.status !== 200 || response.json?.type !== 'server-response') {
    throw new Error(`DSH ${method} failed (${response.status})`);
  }
  if (response.json.result?.ok !== true) {
    throw new Error(`DSH ${method} refused (${response.json.result?.error?.code ?? 'unknown'})`);
  }
  return response.json.result.value;
}

async function ensureDshSession(base, rows, args) {
  const existing = sessionRowByAgent(rows, 'dsh');
  if (existing) return existing;

  const created = await dshRpc(base, 'session.create', { cwd: args.remoteDir }, args.timeoutMs);
  if (!created?.sessionId) throw new Error('DSH session.create returned no session');
  await dshRpc(base, 'session.prompt', {
    sessionId: created.sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: MESSAGE }],
  }, args.timeoutMs);

  const deadline = Date.now() + Math.min(args.timeoutMs, 30_000);
  while (Date.now() < deadline) {
    const state = await fetchJson(
      pluginUrl(base, '/plugins/agent-sidecar/api/state'),
      {},
      args.timeoutMs,
    );
    if (state.status === 200) {
      const row = sessionRowByAgent(state.json?.board?.sessions ?? [], 'dsh');
      if (row) return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function mapLimit(items, limit, worker) {
  const results = Array.from({ length: items.length });
  let cursor = 0;
  async function consume() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return results;
}

function baseResult(agent, mode, sessionId = null) {
  return {
    agent,
    mode,
    sessionSha12: sessionId ? hash(sessionId) : null,
    fixture: false,
    prepare: 'not_run',
    execute: 'not_run',
    delivery: 'unknown',
    outcome: 'failed',
    errorCode: null,
    retries: 0,
  };
}

function failedMatrixReport(args, error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    runId: evidenceId(),
    tier: args.tier,
    host: args.host || '<fixture>',
    remoteDir: args.remoteDir,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ok: false,
    fixture: false,
    matrix: true,
    cases: args.agents.map((agent) => ({
      ...baseResult(agent, agent === 'dsh' ? 'queue' : 'resume'),
      errorCode: 'matrix_error',
    })),
    versions: { center: 'unknown', remoteDsh: 'unknown' },
    drift: [message],
    retryCount: 0,
    knownContracts: {
      kimiUnknownIsTerminal: true,
      dshPersistedPreset409IsNotRetried: true,
    },
  };
}

async function fixtureRun(args) {
  if (args.dryRun) {
    return args.agents.map((agent) => ({
      ...baseResult(agent, agent === 'dsh' ? 'queue' : 'resume'),
      fixture: true,
      prepare: 'simulated',
      execute: 'simulated',
      delivery: 'unknown',
      outcome: 'simulated',
    }));
  }
  return mapLimit(args.agents, args.parallel, async (agent) => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    const result = baseResult(agent, agent === 'dsh' ? 'queue' : 'resume', `${agent}-fixture-session`);
    result.fixture = true;
    result.prepare = 'simulated';
    result.execute = 'simulated';
    result.outcome = 'simulated';
    return result;
  });
}

async function realRun(args) {
  const rig = new Rig({
    host: args.host,
    unreachableHost: `${args.host}-matrix-unreachable`,
  });
  const drift = [];
  try {
    await rescanSshConfig(args.host);
    await rig.boot();
    await rig.ensureReady();
    const started = await rig.api(
      'POST',
      `/api/hosts/${encodeURIComponent(args.host)}/start`,
    );
    if (started.status !== 202) {
      throw new Error(`Center did not accept remote web start (${started.status}: ${JSON.stringify(started.json)})`);
    }
    const host = await rig.waitPhase('running', { timeoutMs: args.timeoutMs });
    if (!host.mappedUrl) throw new Error('Center returned no mapped plugin URL');

    const state = await fetchJson(
      pluginUrl(host.mappedUrl, '/plugins/agent-sidecar/api/state'),
      {},
      args.timeoutMs,
    );
    if (state.status !== 200 || !state.json?.board?.sessions) {
      throw new Error(`plugin state unavailable (${state.status})`);
    }
    const rows = state.json.board.sessions;
    const dshRow = args.agents.includes('dsh')
      ? await ensureDshSession(host.mappedUrl, rows, args)
      : null;
    const work = args.agents.map((agent) => ({
      agent,
      row: agent === 'dsh' ? dshRow : sessionRowByAgent(rows, agent),
    }));

    const results = await mapLimit(work, args.parallel, async ({ agent, row }) => {
      const result = baseResult(agent, agent === 'dsh' ? 'queue' : 'resume', row?.session_id);
      if (!row) {
        result.errorCode = 'session_not_found';
        return result;
      }
      if (row.inject_eligibility?.allowed !== true) {
        result.errorCode = row.inject_eligibility?.reason || 'ineligible_session';
        return result;
      }
      const prepare = await fetchJson(
        pluginUrl(host.mappedUrl, '/plugins/agent-sidecar/api/action'),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'inject.prepare',
            target: { agent, sessionId: row.session_id },
            mode: agent === 'dsh' ? 'queue' : 'queue',
            message: MESSAGE,
          }),
        },
        args.timeoutMs,
      );
      result.prepare = prepare.status;
      if (prepare.status !== 200 || !prepare.json?.requestId || !prepare.json?.confirmToken) {
        result.errorCode = prepare.json?.reason || `prepare_http_${prepare.status}`;
        return result;
      }
      const execute = await fetchJson(
        pluginUrl(host.mappedUrl, '/plugins/agent-sidecar/api/action'),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'inject.execute',
            requestId: prepare.json.requestId,
            confirmToken: prepare.json.confirmToken,
            message: MESSAGE,
          }),
        },
        args.timeoutMs,
      );
      result.execute = execute.status;
      result.delivery = execute.json?.outcome === 'delivered' ? 'delivered' : 'unknown';
      result.outcome = execute.json?.outcome === 'delivered'
        ? 'pass'
        : execute.json?.outcome === 'unknown' ? 'pass_limited' : 'failed';
      result.errorCode = execute.json?.errorCode || null;
      // The token is deliberately not copied into result/evidence.
      return result;
    });
    const after = await fetchJson(
      pluginUrl(host.mappedUrl, '/plugins/agent-sidecar/api/state'),
      {},
      args.timeoutMs,
    );
    if (after.status !== 200) drift.push(`post-matrix plugin state unavailable (${after.status})`);
    return { results, drift, versions: rig.versions };
  } finally {
    await rig.teardown({ keep: args.keep });
  }
}

export async function runMatrix(args) {
  const startedAt = new Date().toISOString();
  const fixture = args.fixture || args.dryRun;
  const execution = fixture
    ? { results: await fixtureRun(args), drift: [], versions: { center: 'fixture', remoteDsh: 'fixture' } }
    : await realRun(args);
  const failed = execution.results.filter((item) => item.outcome === 'failed');
  const limited = execution.results.filter((item) => item.outcome === 'pass_limited');
  return {
    runId: evidenceId(),
    tier: args.tier,
    host: args.host || '<fixture>',
    remoteDir: args.remoteDir,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: failed.length === 0 && limited.length === 0 && !fixture,
    fixture,
    matrix: true,
    cases: execution.results,
    versions: execution.versions,
    drift: execution.drift,
    retryCount: 0,
    knownContracts: {
      kimiUnknownIsTerminal: true,
      dshPersistedPreset409IsNotRetried: true,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 3;
  }
  let report;
  try {
    report = await runMatrix(args);
  } catch (error) {
    report = failedMatrixReport(args, error);
    process.stderr.write(`agent matrix: ${error.message}\n`);
  }
  const saved = writeEvidence(report, {
    directory: args.reportDir,
    hostAliases: args.host ? [args.host] : [],
    previous: readLatestEvidence(args.reportDir),
  });
  process.stdout.write(`agent matrix: ${report.ok ? 'PASS' : report.fixture ? 'SIMULATED' : 'BLOCK/FAIL'}\n`);
  process.stdout.write(`evidence JSON: ${saved.jsonPath}\nevidence Markdown: ${saved.markdownPath}\n`);
  if (report.fixture) return 0;
  return report.ok ? 0 : 1;
}

if (isMainEntry(import.meta.url)) process.exitCode = await main();

export { baseResult, hash, mapLimit, pluginUrl, sessionRowByAgent };
