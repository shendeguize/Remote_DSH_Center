/**
 * 假 dsh web（14 §1.3）：`node fake-dsh-web.js --port N [--cwd PATH] [--die-after MS]`。
 *
 * 行为对齐真机实测事实（README 可行性结论 1）：
 * - 绑定成功后 stdout 输出 `dsh web: http://127.0.0.1:<port>`（可被 POLL 协议解析）
 * - 绑定失败输出 EADDRINUSE 文案并退出（驱动拉起降级路径）
 * - `/` 返回 200 极简页；供隧道转发目标与 monitor TCP 探活使用
 */

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';

/** 孤儿自查间隔：既要够快让开发机不攒残骸，又不至于把 CPU 耗在轮询上。 */
const ORPHAN_CHECK_MS = 500;
/** 测试 RPC 也必须有正文上限，避免垫片本身成为无界内存入口。 */
const RPC_REQUEST_MAX_BYTES = 64 * 1024;

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

const port = Number(flag('port', '0'));
const dieAfter = flag('die-after') === null ? null : Number(flag('die-after'));
const label = flag('label', 'fake-dsh-web');
const launchCwd = flag('cwd', process.cwd());
const forceBindError = argv.includes('--force-bind-error');
const failStart = argv.includes('--fail-start');
const workspaces = new Map();

if (forceBindError) {
  // 端口占用故障注入（scenario bind-busy-*）：文案与真 node 栈一致，POLL 的 BIND_ERR 据此判定
  process.stdout.write(`Error: listen EADDRINUSE: address already in use 127.0.0.1:${port}\n`);
  process.exit(1);
}
if (failStart) {
  // 真崩溃故障注入：无 URL、无 BIND_ERR，进程直接消失 → 驱动 12 §3 的 S2 'dead' 快败
  process.stdout.write('fatal: failed to load web profile\n');
  process.exit(2);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function validWorkspaceRequest(body) {
  return hasExactKeys(body, ['type', 'rpcId', 'method', 'payload'])
    && body.type === 'client-request'
    && typeof body.rpcId === 'string'
    && body.rpcId.length > 0
    && body.method === 'workspace.create'
    && hasExactKeys(body.payload, ['path']);
}

function validHostDescribeRequest(body) {
  return hasExactKeys(body, ['type', 'rpcId', 'method', 'payload'])
    && body.type === 'client-request'
    && typeof body.rpcId === 'string'
    && body.rpcId.length > 0
    && body.method === 'host.describe'
    && hasExactKeys(body.payload, []);
}

function absolutePosixPath(value) {
  return typeof value === 'string'
    && !value.includes('\0')
    && path.posix.isAbsolute(value);
}

function workspaceFor(workspacePath) {
  const existing = workspaces.get(workspacePath);
  if (existing) return { workspace: existing, created: false };

  const now = new Date().toISOString();
  const workspace = {
    workspaceId: `workspace-${randomUUID()}`,
    path: workspacePath,
    title: path.posix.basename(workspacePath),
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
  };
  workspaces.set(workspacePath, workspace);
  return { workspace, created: true };
}

async function readRpcRequest(req) {
  const declared = req.headers['content-length'];
  if (
    declared !== undefined
    && (!/^(?:0|[1-9][0-9]*)$/u.test(declared)
      || Number(declared) > RPC_REQUEST_MAX_BYTES)
  ) {
    req.resume();
    return { error: 413 };
  }

  const chunks = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    total += chunk.byteLength;
    if (total > RPC_REQUEST_MAX_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) return { error: 413 };

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return { error: 400 };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: 400 };
  }
}

async function handleWorkspaceCreate(req, res) {
  if (req.method !== 'POST') {
    req.resume();
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
    return;
  }
  if (!/^application\/json(?:\s*;.*)?$/iu.test(req.headers['content-type'] ?? '')) {
    req.resume();
    sendJson(res, 415, { error: 'application/json required' });
    return;
  }

  const parsed = await readRpcRequest(req);
  if (parsed.error) {
    sendJson(res, parsed.error, { error: 'invalid request body' });
    return;
  }
  if (!validWorkspaceRequest(parsed.value)) {
    sendJson(res, 400, { error: 'invalid workspace.create request' });
    return;
  }

  const { rpcId, payload } = parsed.value;
  if (!absolutePosixPath(payload.path)) {
    sendJson(res, 200, {
      type: 'server-response',
      rpcId,
      result: {
        ok: false,
        error: {
          code: 'workspace-invalid-path',
          message: 'Workspace path must be an absolute POSIX path',
        },
      },
    });
    return;
  }

  sendJson(res, 200, {
    type: 'server-response',
    rpcId,
    result: {
      ok: true,
      value: workspaceFor(payload.path),
    },
  });
}

async function handleHostDescribe(req, res) {
  if (req.method !== 'POST') {
    req.resume();
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
    return;
  }
  if (!/^application\/json(?:\s*;.*)?$/iu.test(req.headers['content-type'] ?? '')) {
    req.resume();
    sendJson(res, 415, { error: 'application/json required' });
    return;
  }

  const parsed = await readRpcRequest(req);
  if (parsed.error) {
    sendJson(res, parsed.error, { error: 'invalid request body' });
    return;
  }
  if (!validHostDescribeRequest(parsed.value)) {
    sendJson(res, 400, { error: 'invalid host.describe request' });
    return;
  }

  sendJson(res, 200, {
    type: 'server-response',
    rpcId: parsed.value.rpcId,
    result: {
      ok: true,
      value: { cwd: launchCwd },
    },
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, label }));
    return;
  }
  if (req.url === '/api/workspace.create') {
    handleWorkspaceCreate(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 400, { error: 'invalid request body' });
      else res.destroy();
    });
    return;
  }
  if (req.url === '/api/host.describe') {
    handleHostDescribe(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 400, { error: 'invalid request body' });
      else res.destroy();
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>${label}</title><h1>${label}</h1>`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // 真 dsh 的 node 栈同样以此文案报错，POLL 协议的 BIND_ERR 判据依赖它
    process.stdout.write(`Error: listen EADDRINUSE: address already in use 127.0.0.1:${port}\n`);
    process.exit(1);
  }
  process.stdout.write(`Error: ${err.message}\n`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  process.stdout.write(`dsh web: http://127.0.0.1:${actual}\n`);
  if (dieAfter !== null) {
    setTimeout(() => {
      process.stdout.write('fatal: dsh web exited unexpectedly\n');
      process.exit(3);
    }, dieAfter);
  }
});

// 孤儿看护：垫片是 detached 起的，运行被 Ctrl-C/SIGKILL 掐断或收尾里抛错时都不会有人来收。
// 造它的那次运行一消失就自己退，免得在开发机上越攒越多、还占着真实 bind 的端口。
const ownerPid = flag('owner-pid') === null ? null : Number(flag('owner-pid'));
if (ownerPid !== null) {
  const watchdog = setInterval(() => {
    try {
      process.kill(ownerPid, 0);
    } catch {
      process.exit(0);
    }
  }, ORPHAN_CHECK_MS);
  watchdog.unref();
}

process.on('SIGTERM', () => {
  process.stdout.write('received SIGTERM, shutting down\n');
  process.exit(0);
});
