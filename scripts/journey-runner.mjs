#!/usr/bin/env node
/* eslint-disable no-await-in-loop */
/**
 * 执行 acceptance-journeys.mjs 中的可执行步骤。
 *
 * 默认只执行真正的 argv 命令或 HTTP 步骤；`harness` 步骤必须由对应的
 * integration adapter 提供，不能被误当成已执行。每一步都会按规格中的
 * exit/status/stdout 断言，任一步失败即返回非零。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/lib/entry.js';
import { JOURNEYS } from './acceptance-journeys.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function replace(value, variables) {
  return value.replaceAll(/\$\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (_, key) => variables[key] ?? `\${${key}}`);
}

export function runProcess(command, { cwd = ROOT, env = process.env, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`步骤超时：${command.join(' ')}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function executeStep(spec, variables, options = {}) {
  const command = spec.command.map((part) => replace(part, variables));
  if (command[0] === 'node' && command[1] === 'src/cli.js') {
    command[0] = process.execPath;
  } else if (command[0] === 'dshc') {
    command.splice(0, 1, process.execPath, path.join(ROOT, 'src', 'cli.js'));
  } else if (['GET', 'POST', 'PUT'].includes(command[0])) {
    const response = await fetch(new URL(command[1], options.baseUrl ?? 'http://127.0.0.1:7788'));
    const body = await response.text();
    return { code: 0, status: response.status, stdout: body, stderr: '' };
  } else if (command[0] === 'harness') {
    throw new Error(`步骤需要 harness adapter，不能伪造执行：${spec.id}`);
  }
  const result = await runProcess(command, options);
  if (result.code === 0 && (spec.expect?.phase || spec.expect?.mappedUrl)) {
    const view = await runProcess([
      process.execPath, path.join(ROOT, 'src', 'cli.js'), 'ls', '--json',
    ], options);
    try {
      const hosts = JSON.parse(view.stdout);
      const host = hosts.find((item) => item.name === variables.host);
      result.phase = host?.phase;
      result.mappedUrl = Boolean(host?.mappedUrl);
    } catch {
      result.phase = null;
      result.mappedUrl = false;
    }
  } else if (spec.expect?.mappedUrl) {
    result.mappedUrl = /https?:\/\//u.test(result.stdout);
  }
  return result;
}

export function assertStep(spec, result) {
  const expected = spec.expect ?? {};
  if (expected.code !== undefined && result.code !== expected.code) {
    throw new Error(`${spec.id}: 期望退出 ${expected.code}，实际 ${result.code}：${result.stderr.trim()}`);
  }
  if (expected.status !== undefined && result.status !== expected.status) {
    throw new Error(`${spec.id}: 期望 HTTP ${expected.status}，实际 ${result.status}`);
  }
  if (expected.stdout && !result.stdout.includes(expected.stdout)) {
    throw new Error(`${spec.id}: stdout 缺少 ${expected.stdout}`);
  }
  if (expected.phase !== undefined && result.phase !== expected.phase) {
    throw new Error(`${spec.id}: 期望 phase=${expected.phase}，实际 ${result.phase ?? 'unknown'}`);
  }
  if (expected.mappedUrl && !result.mappedUrl) {
    throw new Error(`${spec.id}: 期望可用 mappedUrl`);
  }
  if (expected.json && !result.stdout.trim().startsWith('[') && !result.stdout.trim().startsWith('{')) {
    throw new Error(`${spec.id}: 期望 JSON stdout`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const idAt = argv.indexOf('--journey');
  const id = idAt === -1 ? JOURNEYS[0].id : argv[idAt + 1];
  const journey = JOURNEYS.find((item) => item.id === id);
  if (!journey) {
    process.stderr.write(`未知旅程：${id}\n`);
    process.exitCode = 3;
    return;
  }
  const variables = {
    host: process.env.DSHC_ACCEPTANCE_HOST ?? 'localhost',
    unreachableHost: process.env.DSHC_ACCEPTANCE_UNREACHABLE_HOST ?? 'missing-host',
  };
  for (const spec of journey.steps) {
    process.stdout.write(`▶ ${journey.id}/${spec.id}\n`);
    const result = await executeStep(spec, variables, {
      baseUrl: process.env.DSHC_ACCEPTANCE_BASE_URL,
    });
    assertStep(spec, result);
    process.stdout.write(`  ✔ ${spec.command.join(' ')}\n`);
  }
}

if (isMainEntry(import.meta.url)) await main();

export { ROOT };
