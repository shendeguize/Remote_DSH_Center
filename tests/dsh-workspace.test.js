import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DSH_WORKSPACE_RESPONSE_MAX_BYTES,
  registerDshWorkspace,
} from '../src/dsh-workspace.js';
import { _resetQueues, hostQueue } from '../src/lib/ssh.js';

const HOST = 'gpu-1';
const WORKDIR = '/srv/project';
const MAPPED_URL = 'http://127.0.0.1:17701/';

function view(overrides = {}) {
  const base = {
    name: HOST,
    phase: 'running',
    config: { workdir: WORKDIR },
    web: { workdir: WORKDIR, cwd: WORKDIR },
    tunnel: { localPort: 17701, connected: true },
    mappedUrl: MAPPED_URL,
  };
  return {
    ...base,
    ...overrides,
    config: { ...base.config, ...overrides.config },
    web: overrides.web === null ? null : { ...base.web, ...overrides.web },
    tunnel: overrides.tunnel === null ? null : { ...base.tunnel, ...overrides.tunnel },
  };
}

function workspace(overrides = {}) {
  return {
    workspaceId: 'workspace-1',
    path: WORKDIR,
    title: 'project',
    sessionIds: ['session-1'],
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

function rpcResponse(rpcId, {
  created = true,
  workspace: workspaceValue = workspace(),
  result,
  envelope = {},
} = {}) {
  return new Response(JSON.stringify({
    type: 'server-response',
    rpcId,
    result: result ?? {
      ok: true,
      value: { workspace: workspaceValue, created },
    },
    ...envelope,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function describeResponse(rpcId, {
  result = { ok: true, value: { cwd: WORKDIR } },
  envelope = {},
} = {}) {
  return new Response(JSON.stringify({
    type: 'server-response',
    rpcId,
    result,
    ...envelope,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function safeFetch({
  created = true,
  workspace: workspaceValue = workspace(),
  inspect,
} = {}) {
  return async (url, init) => {
    const request = JSON.parse(init.body);
    inspect?.(url, init, request);
    return rpcResponse(request.rpcId, { created, workspace: workspaceValue });
  };
}

function register(current, fetchImpl, options = {}) {
  return registerDshWorkspace(HOST, {
    resolveView: () => current.value,
    fetchImpl,
    timeoutMs: 500,
    ...options,
  });
}

function assertSafeError(error, code, status) {
  assert.equal(error.code, code);
  assert.equal(error.httpStatus, status);
  assert.equal(error.detail, null);
  assert.equal(JSON.stringify(error.toBody()).includes(WORKDIR), false);
  return true;
}

test.beforeEach(() => {
  _resetQueues();
});

test('发送官方 workspace.create 信封并只返回 Center 安全字段', async () => {
  const current = { value: view() };
  const wires = [];
  const result = await register(current, safeFetch({
    inspect(url, init, request) {
      wires.push({ url, init, request });
    },
  }));
  assert.equal(wires.length, 1, '已有绝对 CWD 时不得额外调用 host.describe');
  const [wire] = wires;

  assert.equal(wire.url, `${MAPPED_URL}api/workspace.create`);
  assert.equal(wire.init.method, 'POST');
  assert.deepEqual(wire.init.headers, { 'content-type': 'application/json' });
  assert.equal(typeof wire.init.signal?.aborted, 'boolean');
  assert.equal(
    wire.init.body,
    JSON.stringify({
      type: 'client-request',
      rpcId: wire.request.rpcId,
      method: 'workspace.create',
      payload: { path: WORKDIR },
    }),
    '请求字节必须由固定字段顺序和实测 web.cwd 组成',
  );
  assert.match(wire.request.rpcId, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(result, {
    created: true,
    workspaceId: 'workspace-1',
    title: 'project',
    path: WORKDIR,
  });
  assert.equal(Object.hasOwn(result, 'sessionIds'), false);
  assert.equal(Object.hasOwn(result, 'createdAt'), false);
  assert.equal(Object.hasOwn(result, 'updatedAt'), false);
});

test('CWD 缺失时先调用 host.describe，再以其绝对 cwd 调 workspace.create', async () => {
  const current = {
    value: view({
      local: true,
      web: { cwd: null },
      tunnel: { direct: true, connected: true },
    }),
  };
  const wires = [];
  const result = await register(current, async (url, init) => {
    const request = JSON.parse(init.body);
    wires.push({ url, init, request });
    if (request.method === 'host.describe') {
      return describeResponse(request.rpcId, {
        result: {
          ok: true,
          value: {
            cwd: WORKDIR,
            hostname: 'future-hostname',
          },
          extension: 'future',
        },
        envelope: { extension: { revision: 2 } },
      });
    }
    return rpcResponse(request.rpcId);
  });

  assert.equal(wires.length, 2);
  assert.equal(wires[0].url, `${MAPPED_URL}api/host.describe`);
  assert.equal(
    wires[0].init.body,
    JSON.stringify({
      type: 'client-request',
      rpcId: wires[0].request.rpcId,
      method: 'host.describe',
      payload: {},
    }),
  );
  assert.equal(wires[1].url, `${MAPPED_URL}api/workspace.create`);
  assert.equal(
    wires[1].init.body,
    JSON.stringify({
      type: 'client-request',
      rpcId: wires[1].request.rpcId,
      method: 'workspace.create',
      payload: { path: WORKDIR },
    }),
  );
  assert.notEqual(wires[0].request.rpcId, wires[1].request.rpcId);
  assert.equal(wires[0].init.signal, wires[1].init.signal, '两次 RPC 必须共享同一总截止信号');
  assert.deepEqual(result, {
    created: true,
    workspaceId: 'workspace-1',
    title: 'project',
    path: WORKDIR,
  });
});

test('created:false 是 200 幂等成功', async () => {
  const current = { value: view() };
  assert.deepEqual(
    await register(current, safeFetch({ created: false })),
    {
      created: false,
      workspaceId: 'workspace-1',
      title: 'project',
      path: WORKDIR,
    },
  );
});

test('队首前置条件覆盖存在性、phase、workdir 与实际生效状态', async (t) => {
  const cases = [
    ['host deleted', null, 'NOT_FOUND', 404],
    ['wrong phase', view({ phase: 'ready' }), 'PHASE_CONFLICT', 409],
    ['no configured workdir', view({ config: { workdir: null } }), 'WORKSPACE_WORKDIR_REQUIRED', 400],
    [
      'configured workdir not applied',
      view({ config: { workdir: '/configured/secret' }, web: { workdir: '/running/other' } }),
      'PHASE_CONFLICT',
      409,
    ],
    ['cwd relative', view({ web: { cwd: 'relative/project' } }), 'WORKSPACE_INVALID_PATH', 422],
  ];

  for (const [name, currentView, code, status] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      const current = { value: currentView };
      await assert.rejects(
        () => register(current, async () => {
          calls += 1;
          throw new Error('must not fetch');
        }),
        (error) => {
          assert.equal(error.code, code);
          assert.equal(error.httpStatus, status);
          assert.equal(error.detail, null);
          assert.doesNotMatch(JSON.stringify(error.toBody()), /configured\/secret|running\/other/u);
          if (name === 'configured workdir not applied') assert.match(error.message, /重启.*dsh web/u);
          return true;
        },
      );
      assert.equal(calls, 0);
    });
  }
});

test('running/degraded 只有 tunnel.connected === true 才能访问映射端口', async (t) => {
  const cases = [
    ['running missing tunnel', view({ tunnel: null })],
    ['running disconnected', view({ tunnel: { connected: false } })],
    ['degraded disconnected', view({ phase: 'degraded', tunnel: { connected: false } })],
    [
      'local direct disconnected',
      view({ local: true, tunnel: { direct: true, connected: false } }),
    ],
  ];

  for (const [name, currentView] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      await assert.rejects(
        () => register({ value: currentView }, async () => {
          calls += 1;
          throw new Error('must not fetch released mapped port');
        }),
        (error) => assertSafeError(error, 'PHASE_CONFLICT', 409),
      );
      assert.equal(calls, 0);
    });
  }
});

test('mappedUrl 必须逐字为安全环回根 URL，拒绝 SSRF 与路径拼接', async () => {
  const unsafe = [
    null,
    'https://127.0.0.1:17701/',
    'http://localhost:17701/',
    'http://127.0.0.2:17701/',
    'http://user@127.0.0.1:17701/',
    'http://127.0.0.1:17701/base/',
    'http://127.0.0.1:17701/?next=evil',
    'http://127.0.0.1:17701/#fragment',
    'http://127.0.0.1:17701',
    'http://127.0.0.1:65536/',
    'http://127.0.0.1:017701/',
  ];
  let calls = 0;

  for (const mappedUrl of unsafe) {
    const current = { value: view({ mappedUrl }) };
    await assert.rejects(
      () => register(current, async () => {
        calls += 1;
        throw new Error('must not fetch');
      }),
      (error) => assertSafeError(error, 'WORKSPACE_REGISTER_FAILED', 502),
    );
  }
  assert.equal(calls, 0);
});

test('严格拒绝 rpcId、信封、result 与 workspace 畸形响应', async (t) => {
  const malformed = [
    ['rpcId mismatch', (id) => rpcResponse(`${id}-other`)],
    ['wrong type', (id) => rpcResponse(id, { envelope: { type: 'client-response' } })],
    ['missing result value', (id) => rpcResponse(id, { result: { ok: true } })],
    ['missing workspace field', (id) => rpcResponse(id, {
      workspace: { workspaceId: 'workspace-1', path: WORKDIR },
    })],
    ['relative returned path', (id) => rpcResponse(id, {
      workspace: workspace({ path: 'relative/project' }),
    })],
  ];

  for (const [name, respond] of malformed) {
    await t.test(name, async () => {
      const current = { value: view() };
      await assert.rejects(
        () => register(current, async (_url, init) => {
          const { rpcId } = JSON.parse(init.body);
          return respond(rpcId);
        }),
        (error) => assertSafeError(error, 'WORKSPACE_REGISTER_FAILED', 502),
      );
    });
  }
});

test('host.describe 严格校验信封并安全处理错误、缺失或相对 cwd', async (t) => {
  const secret = 'DESCRIBE_SECRET_/private/project';
  const cases = [
    ['rpcId mismatch', (id) => describeResponse(`${id}-other`), 'WORKSPACE_REGISTER_FAILED', 502],
    ['missing result value', (id) => describeResponse(id, {
      result: { ok: true },
    }), 'WORKSPACE_REGISTER_FAILED', 502],
    ['malformed error', (id) => describeResponse(id, {
      result: { ok: false, error: { message: secret } },
    }), 'WORKSPACE_REGISTER_FAILED', 502],
    ['domain error', (id) => describeResponse(id, {
      result: {
        ok: false,
        error: { code: 'future-host-error', message: secret, details: { cwd: secret } },
      },
    }), 'WORKSPACE_REGISTER_FAILED', 502],
    ['missing cwd', (id) => describeResponse(id, {
      result: { ok: true, value: { hostname: 'gpu-1' } },
    }), 'WORKSPACE_CWD_UNAVAILABLE', 409],
    ['relative cwd', (id) => describeResponse(id, {
      result: { ok: true, value: { cwd: `relative/${secret}` } },
    }), 'WORKSPACE_CWD_UNAVAILABLE', 409],
    [
      'oversized response',
      () => new Response('x'.repeat(DSH_WORKSPACE_RESPONSE_MAX_BYTES + 1)),
      'WORKSPACE_REGISTER_FAILED',
      502,
    ],
  ];

  for (const [name, respond, expectedCode, expectedStatus] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      await assert.rejects(
        () => register({ value: view({ web: { cwd: null } }) }, async (_url, init) => {
          calls += 1;
          const { rpcId, method } = JSON.parse(init.body);
          assert.equal(method, 'host.describe');
          return respond(rpcId);
        }),
        (error) => {
          assertSafeError(error, expectedCode, expectedStatus);
          assert.doesNotMatch(JSON.stringify(error.toBody()), /DESCRIBE_SECRET|private/u);
          return true;
        },
      );
      assert.equal(calls, 1, 'describe 失败后不得调用 workspace.create');
    });
  }

  await t.test('transport error', async () => {
    await assert.rejects(
      () => register({ value: view({ web: { cwd: null } }) }, async () => {
        throw new Error(secret);
      }),
      (error) => {
        assertSafeError(error, 'WORKSPACE_REGISTER_FAILED', 502);
        assert.doesNotMatch(JSON.stringify(error.toBody()), /DESCRIBE_SECRET|private/u);
        return true;
      },
    );
  });
});

test('响应解析兼容 dsh 后续新增字段，只返回 Center 消费的安全子集', async () => {
  const current = { value: view() };
  const result = await register(current, async (_url, init) => {
    const { rpcId } = JSON.parse(init.body);
    return rpcResponse(rpcId, {
      envelope: { extension: { revision: 2 } },
      result: {
        ok: true,
        value: {
          workspace: workspace({ extension: 'future' }),
          created: true,
          extension: 'future',
        },
        extension: 'future',
      },
    });
  });

  assert.deepEqual(result, {
    created: true,
    workspaceId: 'workspace-1',
    title: 'project',
    path: WORKDIR,
  });
});

test('响应体严格封顶 64 KiB，非法 UTF-8/JSON 统一按安全协议错误处理', async (t) => {
  assert.equal(DSH_WORKSPACE_RESPONSE_MAX_BYTES, 64 * 1024);
  const cases = [
    ['oversized', new Response('x'.repeat(DSH_WORKSPACE_RESPONSE_MAX_BYTES + 1))],
    ['invalid JSON', new Response('{"secret":"/private/upstream"')],
    ['invalid UTF-8', new Response(new Uint8Array([0xff, 0xfe]))],
  ];

  for (const [name, response] of cases) {
    await t.test(name, async () => {
      const current = { value: view() };
      await assert.rejects(
        () => register(current, async () => response),
        (error) => {
          assertSafeError(error, 'WORKSPACE_REGISTER_FAILED', 502);
          assert.doesNotMatch(JSON.stringify(error.toBody()), /private|secret/u);
          return true;
        },
      );
    });
  }
});

test('HTTP、transport 与上游 domain 错误不回显原始正文、message、details', async (t) => {
  const secret = 'UPSTREAM_SECRET_/private/project';
  const cases = [
    ['http', async () => new Response(secret, { status: 503 }), 'WORKSPACE_REGISTER_FAILED', 502],
    ['transport', async () => { throw new Error(secret); }, 'WORKSPACE_REGISTER_FAILED', 502],
    ['invalid-path domain', async (_url, init) => {
      const { rpcId } = JSON.parse(init.body);
      return rpcResponse(rpcId, {
        result: {
          ok: false,
          error: {
            code: 'workspace-invalid-path',
            message: secret,
            details: { path: secret },
          },
        },
      });
    }, 'WORKSPACE_INVALID_PATH', 422],
    ['unknown domain', async (_url, init) => {
      const { rpcId } = JSON.parse(init.body);
      return rpcResponse(rpcId, {
        result: {
          ok: false,
          error: {
            code: 'future-workspace-error',
            message: secret,
            details: { path: secret },
            extension: 'future',
          },
          extension: 'future',
        },
      });
    }, 'WORKSPACE_REGISTER_FAILED', 502],
  ];

  for (const [name, fetchImpl, expectedCode, expectedStatus] of cases) {
    await t.test(name, async () => {
      const current = { value: view() };
      await assert.rejects(
        () => register(current, fetchImpl),
        (error) => {
          assertSafeError(error, expectedCode, expectedStatus);
          assert.doesNotMatch(JSON.stringify(error.toBody()), /UPSTREAM_SECRET|private/u);
          return true;
        },
      );
    });
  }
});

test('同主机 admission slot 立即 busy，完成后释放', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const current = { value: view() };
  const first = register(current, async (_url, init) => {
    await held;
    return rpcResponse(JSON.parse(init.body).rpcId);
  });
  await new Promise((resolve) => { setTimeout(resolve, 10); });

  const started = performance.now();
  await assert.rejects(
    () => register(current, safeFetch()),
    (error) => error.code === 'WORKSPACE_BUSY' && error.httpStatus === 409,
  );
  assert.ok(performance.now() - started < 100, 'busy 必须在 admission 处快败，不能排进 hostQueue');

  release();
  await first;
  assert.equal((await register(current, safeFetch())).created, true, '完成后 slot 必须恢复');
});

test('排队期间不捕获旧 HostView，在队首重查删除、phase 与 workdir 变化', async (t) => {
  const mutations = [
    ['deleted', () => null, 'NOT_FOUND'],
    ['phase', () => view({ phase: 'ready' }), 'PHASE_CONFLICT'],
    [
      'workdir',
      () => view({ config: { workdir: '/new/configured' }, web: { workdir: WORKDIR, cwd: WORKDIR } }),
      'PHASE_CONFLICT',
    ],
    [
      'disconnected',
      () => view({ phase: 'degraded', tunnel: { connected: false } }),
      'PHASE_CONFLICT',
    ],
  ];

  for (const [name, mutate, code] of mutations) {
    await t.test(name, async () => {
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      const blocker = hostQueue(HOST).run('lifecycle-hold', async () => held, { timeoutMs: 1_000 });
      const current = { value: view() };
      let resolverCalls = 0;
      let fetchCalls = 0;
      const pending = registerDshWorkspace(HOST, {
        resolveView: () => {
          resolverCalls += 1;
          return current.value;
        },
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error('must not fetch');
        },
        timeoutMs: 500,
      });

      await new Promise((resolve) => { setTimeout(resolve, 15); });
      assert.equal(resolverCalls, 0);
      current.value = mutate();
      release();
      await blocker;
      await assert.rejects(() => pending, (error) => error.code === code);
      assert.equal(resolverCalls, 1);
      assert.equal(fetchCalls, 0);
      current.value = view();
      assert.equal((await register(current, safeFetch())).created, true, '队首拒绝后 slot 必须释放');
    });
  }
});

test('超时与调用方 abort 会取消 fetch、在 15 秒内失败并释放 slot', async (t) => {
  await t.test('timeout', async () => {
    const current = { value: view() };
    let fetchSignal;
    const started = performance.now();
    await assert.rejects(
      () => registerDshWorkspace(HOST, {
        resolveView: () => current.value,
        fetchImpl: async (_url, init) => {
          fetchSignal = init.signal;
          return new Promise(() => {});
        },
        timeoutMs: 30,
      }),
      (error) => {
        assert.equal(error.code, 'WORKSPACE_REGISTER_TIMEOUT');
        assert.equal(error.httpStatus, 504);
        assert.match(error.message, /幂等|安全重试/u);
        return true;
      },
    );
    assert.ok(performance.now() - started < 300);
    assert.equal(fetchSignal.aborted, true);
    assert.equal((await register(current, safeFetch())).created, true);
  });

  await t.test('caller abort', async () => {
    const current = { value: view() };
    const controller = new AbortController();
    let fetchSignal;
    const pending = registerDshWorkspace(HOST, {
      resolveView: () => current.value,
      fetchImpl: async (_url, init) => {
        fetchSignal = init.signal;
        return new Promise(() => {});
      },
      signal: controller.signal,
      timeoutMs: 500,
    });
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    controller.abort();
    await assert.rejects(
      () => pending,
      (error) => error.code === 'WORKSPACE_REGISTER_TIMEOUT' && error.httpStatus === 504,
    );
    assert.equal(fetchSignal.aborted, true);
    assert.equal((await register(current, safeFetch())).created, true);
  });
});
