/**
 * 目标 3：schema 校验器（`src/lib/validate.js`）。
 *
 * 校验器是 HTTP 面与 config 文件的**唯一**前门：它放行的东西会直接变成远端命令的参数。
 * 两族性质：
 *
 *   变异必被拒   从一份合法 config 出发，施加一个**按构造就非法**的变异，校验必须红，
 *                且错误路径必须指到变异的那个位置。判「红了没有」不够——错误路径指错了
 *                地方，用户就得靠猜，而猜不出来的人会去关掉校验。
 *   任意输入不崩  拿随机 JSON 轰十份 schema：`validate` 必须**总是**返回判决，绝不抛。
 *                前门自己崩了就是 500，而 500 意味着攻击者拿到了一个可复现的拒绝服务。
 *                顺带盯原型污染——`__proto__` / `constructor` 是随机键里的常客。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertValid, configSchema, defaultsPatchSchema, dshSettingsPutSchema, dshWorkspaceCreateSchema,
  hostConfigPatchSchema, hostStateSchema, localHostCreateSchema, setupBodySchema, stateSchema,
  syncConfigBodySchema, validate,
} from '../../src/lib/validate.js';
import { CONFIG_VERSION } from '../../src/defaults.js';
import { PHASES } from '../../src/lib/machine.js';
import { ALPHABETS, Rng } from './prng.js';
import { runFuzzTarget } from './runner.js';

const SCHEMAS = Object.freeze({
  config: configSchema,
  state: stateSchema,
  hostState: hostStateSchema,
  setupBody: setupBodySchema,
  hostConfigPatch: hostConfigPatchSchema,
  localHostCreate: localHostCreateSchema,
  dshWorkspaceCreate: dshWorkspaceCreateSchema,
  syncConfigBody: syncConfigBodySchema,
  dshSettingsPut: dshSettingsPutSchema,
  defaultsPatch: defaultsPatchSchema,
});

/** 随机键里掺进这些：原型链上的三个名字 + 几个真实字段名（真实名更容易走到深处）。 */
const HOSTILE_KEYS = Object.freeze([
  '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty',
  'hosts', 'inject', 'env', 'extraArgs', 'patches', 'manager', 'port', 'defaults',
  'localPortRange', 'remoteWebPort', 'phase', 'enabled', 'local', 'localPort', 'workdir',
]);

// ── 合法 config 生成 ────────────────────────────────────────────────────

function hostName(rng) {
  return rng.string({ min: 1, max: 10, alphabet: 'abcdefghijkl0123456789-_.' });
}

function validHost(rng) {
  const env = {};
  for (let i = 0; i < rng.int(0, 2); i += 1) {
    env[`${rng.pick([...'abcXYZ_'])}${rng.string({ min: 0, max: 5, alphabet: 'abc_019' })}`] = rng.nasty({ max: 8 });
  }
  return {
    enabled: rng.bool(),
    autoStart: rng.bool(),
    localPort: rng.bool(0.3) ? rng.int(1, 65_535) : null,
    remoteWebPort: rng.bool(0.7) ? rng.int(1, 65_535) : null,
    workdir: rng.pickWeighted([[3, null], [2, `/${rng.string({ max: 8, alphabet: 'abc/._-' })}`], [1, '~']]),
    inject: {
      env,
      extraArgs: Array.from({ length: rng.int(0, 3) }, () => rng.nasty({ max: 8 })),
      patches: Array.from({ length: rng.int(0, 2) }, () => rng.string({ min: 1, max: 8, alphabet: 'abc/._-' })),
    },
  };
}

function validConfig(rng) {
  const hosts = {};
  for (let i = 0; i < rng.int(1, 4); i += 1) hosts[hostName(rng)] = validHost(rng);
  const lo = rng.int(1_024, 60_000);
  return {
    configVersion: CONFIG_VERSION,
    setupCompleted: rng.bool(),
    manager: { port: rng.int(1, 65_535) },
    defaults: {
      remoteWebPort: rng.int(1, 65_535),
      localPortRange: [lo, rng.int(lo, 65_535)],
    },
    hosts,
  };
}

// ── 变异表：每条都「按构造非法」，并自报该指向哪个路径 ───────────────────

/**
 * 每个变异器返回 `{ path, why }`；`path` 是期望在错误里出现的路径前缀。
 * 返回 null = 这份 config 上用不了这个变异（例如没有可改的主机），换一个。
 * @type {ReadonlyArray<{id:string, apply:(cfg:object, rng:object)=>({path:string,why:string}|null)}>}
 */
const MUTATORS = Object.freeze([
  {
    id: 'delete-required',
    apply(cfg, rng) {
      const key = rng.pick(['configVersion', 'setupCompleted', 'manager', 'defaults', 'hosts']);
      delete cfg[key];
      return { path: key, why: 'required' };
    },
  },
  {
    id: 'unknown-top-key',
    apply(cfg, rng) {
      const key = `zz_${rng.string({ min: 1, max: 6 })}`;
      if (Object.hasOwn(cfg, key)) return null;
      cfg[key] = 1;
      return { path: key, why: 'unknown key' };
    },
  },
  {
    id: 'type-swap',
    apply(cfg, rng) {
      const wrong = rng.pick([null, [], 'x', 42, true, {}]);
      const key = rng.pick(['configVersion', 'setupCompleted', 'manager', 'hosts']);
      const same = (key === 'configVersion' && typeof wrong === 'number' && Number.isInteger(wrong))
        || (key === 'setupCompleted' && typeof wrong === 'boolean')
        || (['manager', 'hosts'].includes(key) && wrong !== null && typeof wrong === 'object' && !Array.isArray(wrong));
      if (same) return null; // 换了个同型的值，等于没变异
      cfg[key] = wrong;
      return { path: key, why: 'expected' };
    },
  },
  {
    id: 'port-out-of-range',
    apply(cfg, rng) {
      cfg.manager.port = rng.pick([0, -1, 65_536, 1e6]);
      return { path: 'manager.port', why: 'int' };
    },
  },
  {
    id: 'port-not-integer',
    apply(cfg, rng) {
      cfg.manager.port = rng.pick([1.5, Number.NaN, '8080', null]);
      return { path: 'manager.port', why: 'int' };
    },
  },
  {
    id: 'range-reversed',
    apply(cfg, rng) {
      const hi = rng.int(2_000, 60_000);
      cfg.defaults.localPortRange = [hi, hi - rng.int(1, 900)];
      return { path: 'defaults.localPortRange', why: 'range start must be <= end' };
    },
  },
  {
    id: 'range-below-bindable',
    apply(cfg, rng) {
      cfg.defaults.localPortRange = [rng.int(1, 1_023), rng.int(2_000, 60_000)];
      return { path: 'defaults.localPortRange[0]', why: 'int 1024' };
    },
  },
  {
    id: 'range-wrong-arity',
    apply(cfg, rng) {
      cfg.defaults.localPortRange = rng.pick([[1_100], [1_100, 2_000, 3_000], []]);
      return { path: 'defaults.localPortRange', why: 'tuple' };
    },
  },
  {
    id: 'host-unknown-key',
    apply(cfg, rng) {
      const name = firstHost(cfg, rng);
      if (name === null) return null;
      cfg.hosts[name].zzz = 1;
      return { path: `hosts.${name}.zzz`, why: 'unknown key' };
    },
  },
  {
    id: 'host-workdir-relative',
    apply(cfg, rng) {
      const name = firstHost(cfg, rng);
      if (name === null) return null;
      cfg.hosts[name].workdir = rng.pick(['relative/path', '', 'x', './a', 'a\nb']);
      return { path: `hosts.${name}.workdir`, why: '绝对路径' };
    },
  },
  {
    id: 'host-env-illegal-key',
    apply(cfg, rng) {
      const name = firstHost(cfg, rng);
      if (name === null) return null;
      const key = rng.pick(['bad-key', '1abc', 'a b', 'a=b', '', 'a$b']);
      cfg.hosts[name].inject.env[key] = 'v';
      return { path: `hosts.${name}.inject.env`, why: 'invalid key' };
    },
  },
  {
    id: 'host-extra-args-not-string',
    apply(cfg, rng) {
      const name = firstHost(cfg, rng);
      if (name === null) return null;
      cfg.hosts[name].inject.extraArgs = [rng.pick([1, null, true, {}, []])];
      return { path: `hosts.${name}.inject.extraArgs[0]`, why: 'expected string' };
    },
  },
  {
    id: 'host-patch-empty',
    apply(cfg, rng) {
      const name = firstHost(cfg, rng);
      if (name === null) return null;
      cfg.hosts[name].inject.patches = ['', ...cfg.hosts[name].inject.patches];
      return { path: `hosts.${name}.inject.patches[0]`, why: 'length >= 1' };
    },
  },
  {
    id: 'local-with-port',
    apply(cfg, rng) {
      const name = firstHost(cfg, rng);
      if (name === null) return null;
      cfg.hosts[name].local = true;
      cfg.hosts[name].localPort = rng.int(1, 65_535);
      return { path: `hosts.${name}.localPort`, why: '必须为 null' };
    },
  },
  {
    id: 'local-bad-name',
    apply(cfg, rng) {
      // 本机主机名会进 ssh 的参数位，故它这一支的字符集收得比普通主机紧
      const bad = rng.pick(['-lead', 'has space', 'has/slash', 'has$dollar', 'quote"x']);
      if (Object.hasOwn(cfg.hosts, bad)) return null;
      cfg.hosts[bad] = { ...validHostFrom(cfg), local: true, localPort: null };
      return { path: `hosts.${bad}`, why: '本机主机名' };
    },
  },
]);

/**
 * 错误行的路径是不是「期望路径或它的下级」。
 * 允许下级：`inject.env` 上的非法键，错误自然指在 `inject.env.<那个键>` 上——比只报
 * 父路径更有用，不该因为「不是逐字相等」判红。`<root>` 是整体约束的落点。
 */
function pathMatches(line, path) {
  const colon = line.indexOf(':');
  const actual = colon === -1 ? line : line.slice(0, colon);
  if (actual === '<root>') return true;
  if (actual === path) return true;
  return actual.startsWith(path) && ['.', '['].includes(actual[path.length]);
}

function firstHost(cfg, rng) {
  const names = Object.keys(cfg.hosts ?? {});
  return names.length === 0 ? null : rng.pick(names);
}

function validHostFrom(cfg) {
  const first = Object.values(cfg.hosts)[0];
  return JSON.parse(JSON.stringify(first));
}

// ── 生成与判定 ──────────────────────────────────────────────────────────

function gen(rng) {
  return {
    config: validConfig(rng),
    // 记变异器的 id 而不是下标：语料要活很久，而变异表会增删。存下标的话，往表中间
    // 插一条就把所有历史语料的含义悄悄换掉了——回放的还是那串输入，验的却是另一条性质。
    mutator: rng.pick(MUTATORS).id,
    mutatorSeed: rng.int(0, 0xffff_ffff),
    garbage: Array.from({ length: 3 }, () => randomJson(rng, 0)),
  };
}

function check(input) {
  checkMutation(input);
  checkRobustness(input);
}

function checkMutation(input) {
  const base = input.config;
  const clean = validate(configSchema, base);
  assert.deepEqual(clean.errors, [], `生成器造出了不合法的 config：${JSON.stringify(base)}`);
  assert.equal(clean.ok, true);
  // setupBody 与 config 同形（只是两个键可缺省），合法 config 必然也是合法 setupBody
  assert.equal(validate(setupBodySchema, base).ok, true, '合法 config 却不是合法 setup 体');

  const mutator = MUTATORS.find((m) => m.id === input.mutator);
  assert.ok(mutator, `语料引用了已不存在的变异器 ${JSON.stringify(input.mutator)}：删变异器要同时处理语料`);
  const mutated = JSON.parse(JSON.stringify(base));
  // 变异器用自己的随机流：换掉主流的生成逻辑不会连带改掉「哪条变异怎么变」
  const expected = mutator.apply(mutated, new Rng(input.mutatorSeed));
  if (expected === null) return; // 这份 config 上用不了这个变异

  const after = validate(configSchema, mutated);
  assert.equal(
    after.ok,
    false,
    `变异 ${mutator.id} 没被拦住（这条变异按构造就是非法的）：${JSON.stringify(mutated)}`,
  );
  assert.ok(
    after.errors.some((line) => pathMatches(line, expected.path)),
    `变异 ${mutator.id} 红了，但错误路径没指到 ${expected.path}：\n${after.errors.join('\n')}`,
  );
  for (const line of after.errors) {
    assert.ok(!line.includes('[object Object]'), `错误信息里漏出了 [object Object]：${line}`);
    assert.ok(!line.includes('undefined:'), `错误路径里有 undefined：${line}`);
  }

  assert.throws(
    () => assertValid(configSchema, mutated, '配置不合法'),
    (error) => error?.code === 'VALIDATION' && typeof error.detail === 'string' && error.detail.length > 0,
    `assertValid 该抛带 detail 的 VALIDATION（变异 ${mutator.id}）`,
  );
}

/** 前门不许崩：任意 JSON 进任意 schema，只许返回判决。 */
function checkRobustness(input) {
  for (const value of input.garbage) {
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      let verdict;
      try {
        verdict = validate(schema, value);
      } catch (error) {
        assert.fail(`${name} 被输入弄崩了（前门崩掉就是 500）：${error?.stack ?? error}`);
      }
      assert.equal(typeof verdict.ok, 'boolean', `${name} 的判决 ok 不是布尔`);
      assert.ok(Array.isArray(verdict.errors), `${name} 的 errors 不是数组`);
      assert.equal(verdict.ok, verdict.errors.length === 0, `${name} 的 ok 与 errors 自相矛盾`);
      for (const line of verdict.errors) {
        assert.equal(typeof line, 'string', `${name} 的错误项不是字符串`);
        assert.ok(line.length > 0, `${name} 出了空错误项`);
      }
    }
    assert.equal({}.polluted, undefined, '原型被污染了');
    assert.equal(Object.prototype.polluted, undefined, '原型被污染了');
    assert.equal(typeof {}.toString, 'function', 'Object.prototype.toString 被顶掉了');
  }
}

// ── 随机 JSON ───────────────────────────────────────────────────────────

const MAX_DEPTH = 4;

function randomJson(rng, depth) {
  if (depth >= MAX_DEPTH) return leaf(rng);
  return rng.pickWeighted([
    [4, () => leaf(rng)],
    [3, () => randomObject(rng, depth)],
    [2, () => randomArray(rng, depth)],
  ])();
}

function leaf(rng) {
  return rng.pickWeighted([
    [3, () => rng.nasty({ max: 10, alphabet: ALPHABETS.json })],
    [2, () => rng.int(-70_000, 70_000)],
    [1, () => rng.float() * 1e6],
    [2, () => rng.bool()],
    [2, () => null],
    [1, () => PHASES[rng.int(0, PHASES.length - 1)]],
  ])();
}

function randomObject(rng, depth) {
  const obj = {};
  for (let i = 0; i < rng.int(0, 4); i += 1) {
    const key = rng.bool(0.6) ? rng.pick(HOSTILE_KEYS) : rng.string({ min: 0, max: 6 });
    assign(obj, key, randomJson(rng, depth + 1));
  }
  return obj;
}

function randomArray(rng, depth) {
  return Array.from({ length: rng.int(0, 4) }, () => randomJson(rng, depth + 1));
}

/**
 * `obj.__proto__ = v` 会去改原型而不是加一个自有属性——那就测不到「校验器遇到名叫
 * __proto__ 的**字段**会怎样」。defineProperty 才能造出真正的自有属性
 * （`JSON.parse('{"__proto__":1}')` 造出来的也正是这种）。
 */
function assign(obj, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(obj, key, {
      value, enumerable: true, configurable: true, writable: true,
    });
    return;
  }
  obj[key] = value;
}

test('fuzz：schema 变异必被拒 + 任意输入不崩', async (t) => {
  const stats = await runFuzzTarget(t, {
    target: 'validate-mutation', gen, check, minCorpus: 2,
  });
  assert.ok(stats.corpus + stats.generated > 0, '一个例子都没跑');
});
