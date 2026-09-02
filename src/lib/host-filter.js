/**
 * ssh config 主机名的白/黑名单（正则）。
 *
 * 为什么要有这层：`~/.ssh/config` 是人给 ssh 用的，不是给本工具用的。里面混着一大批
 * 压根不是「能跑 dsh 的机器」的条目——代码托管入口（git.example.com、github.com）、
 * 只用来转发的跳板别名、同事共享的一次性条目。它们被自动纳管后只会在主机表里长期挂着
 * 「SSH 不可达」，还要吃掉每一轮巡检的扇出额度。
 *
 * 三条判定纪律：
 * 1. **整串锚定**：`git.*` 是 `^(?:git.*)$`，命中 `git.neodrive.neolix.net`、`gitlab-x`，
 *    不命中 `mygit-box`。半截命中比不命中更让人吃惊，故不做子串搜索。
 * 2. **忽略大小写**：主机名的大小写来自人手写的 config，`GitHub.com` 与 `github.com`
 *    指同一个地方，判定不该因此分家。
 * 3. **黑名单优先**：白名单是「只认这些」，黑名单是「这些不要」；同时命中按不要算。
 *
 * 名单是用户可编辑的正则，等于让配置文件里的字符串驱动本进程的正则引擎，所以这里
 * 挡住指数回溯的形状（见 assertSafePattern）。
 */

import { DshError } from './errors.js';

/** @typedef {{allow?:string[], deny?:string[]}} HostFilterConfig */
/** @typedef {{rule:'allow'|'deny', pattern:string}} HostFilterVerdict */

export const HOST_FILTER_LIMITS = Object.freeze({
  /** 每份名单的条数上限：名单是逐台逐条跑的，条数直接乘进巡检的开销 */
  maxPatterns: 32,
  /** 单条长度上限 */
  maxPatternLength: 200,
});

/** 量词：`*` `+` `?` `{n}` `{n,}` `{n,m}`，尾随的 `?`（懒惰）算同一个量词 */
const QUANTIFIER = /^(?:(?<simple>[*+?])|\{(?<min>\d*)(?<comma>,)?(?<max>\d*)\})\??/;
/** 分组前缀：`(?:` `(?=` `(?!` `(?<=` `(?<!` `(?<name>`。里面那个 `?` 不是量词 */
const GROUP_PREFIX = /^\(\?(?::|=|!|<[=!]|<[^>]*>)/;

/**
 * 读出 `at` 处的量词。
 * @returns {{length:number, maxReps:number, variable:boolean}|null}
 *   variable = 这个量词让被修饰的原子「能吃掉多少字符」有多种解释；
 *   maxReps = 最多重复几次（Infinity 表示无界）。
 */
function readQuantifier(source, at) {
  const m = QUANTIFIER.exec(source.slice(at));
  if (!m) return null;
  const { simple, min, comma, max } = m.groups;
  if (simple) {
    return { length: m[0].length, maxReps: simple === '?' ? 1 : Infinity, variable: true };
  }
  // `{` 后面不是数字就不是量词，JS 当字面花括号处理（如 host\{a\}）
  if (min === '' && !comma) return null;
  const lo = min === '' ? 0 : Number(min);
  const hi = comma ? (max === '' ? Infinity : Number(max)) : lo;
  return { length: m[0].length, maxReps: hi, variable: lo !== hi };
}

/**
 * 挡住指数/多项式回溯的形状：**把一个「重复起来有歧义」的分组再重复两次以上**。
 *
 * 歧义来自分组内部「能吃多少字符有多种解释」——内部有变长量词（`(a+)+`、`([a-z]*)*`、
 * `(a{2,4})+`），或内部有分支（`(x|xx)+`）。外层只要能重复 2 次以上就会把这些解释
 * 组合起来搜索：`(a+)+$` 撞上 64 个 a 加一个不匹配的字符要走 2^64 步；有界的外层
 * 也救不了，`(a+){12}` 是 C(63,11)≈10^12 步。两者都会把 manager 卡死在一次配置保存里。
 *
 * 注意判定用的是「变长」而不是「无界」：`{2,4}` 有界但仍是变长，`(a{2,4})+` 实测能跑
 * 到 144 秒（tests/lib/host-filter.test.js 的性质测试就是撞出这条的）。反过来定长的
 * `(a{2})+` 每一步只有一种解释，放行。
 *
 * 用静态判形而不是「跑一遍看耗时」：要靠计时识别它，就得先真的跑它，而跑它本身就是
 * 那次卡死。判形是确定性的，测试也不会因为跑测机忙而飘。
 *
 * 代价是拒掉 `(foo.*bar)+`、`(git|hub)+` 这类「合法但对主机名毫无意义」的写法。真正用得上
 * 的形态一条不伤：量词加在分组**外面**才犯规，`(gitlab|github)\..*` 的 `.*` 不在分组上。
 * @returns {string|null} 拒绝原因；null = 没有这类形状
 */
function findNestedQuantifier(source) {
  /** 每层分组一条记录；下标 0 是整条正则的顶层。risky = 重复它会产生歧义 */
  const stack = [{ risky: false }];
  let inClass = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      stack.push({ risky: false });
      const prefix = GROUP_PREFIX.exec(source.slice(i));
      if (prefix) i += prefix[0].length - 1;
      continue;
    }
    if (ch === '|') {
      // 分支让「这一段吃到哪」有多种解释，再重复就是组合展开
      stack[stack.length - 1].risky = true;
      continue;
    }
    if (ch === ')') {
      const group = stack.pop() ?? { risky: false };
      if (stack.length === 0) stack.push({ risky: false }); // 括号不配对，交给后面的编译报错
      const parent = stack[stack.length - 1];
      const quantifier = readQuantifier(source, i + 1);
      if (quantifier && quantifier.maxReps > 1 && group.risky) {
        return '嵌套量词：把「内部有变长量词或分支」的分组重复两次以上（如 (a+)+、(a{2,4})+），会指数回溯';
      }
      // 分组内的歧义对父层同样算数：((a+))+ 与 (a+)+ 是一回事
      if (group.risky || quantifier?.variable) parent.risky = true;
      if (quantifier) i += quantifier.length;
      continue;
    }
    const quantifier = readQuantifier(source, i);
    if (quantifier) {
      if (quantifier.variable) stack[stack.length - 1].risky = true;
      i += quantifier.length - 1;
    }
  }
  return null;
}

/**
 * 单条正则的形态判定。
 * @param {unknown} pattern
 * @returns {string|null} 拒绝原因；null = 可用
 */
export function checkHostPattern(pattern) {
  if (typeof pattern !== 'string') return `须为字符串，收到 ${pattern === null ? 'null' : typeof pattern}`;
  if (pattern === '') return '不得为空串（空串会挡下所有主机）';
  if (pattern.length > HOST_FILTER_LIMITS.maxPatternLength) {
    return `长度须 <= ${HOST_FILTER_LIMITS.maxPatternLength}，收到 ${pattern.length}`;
  }
  // 控制字符进不了主机名，出现即为误粘贴（换行还会把一条写成两条）
  if (/[\u0000-\u001F\u007F]/u.test(pattern)) return '不得含控制字符或换行';

  const nested = findNestedQuantifier(pattern);
  if (nested) return nested;

  try {
    new RegExp(`^(?:${pattern})$`, 'i');
  } catch (err) {
    return `不是合法正则：${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

/**
 * 编译一份名单，得到判定器。名单非法直接抛 VALIDATION——这是配置校验的一部分，
 * 不允许「静默丢掉一条看不懂的规则」：那会让人以为屏蔽生效了，其实没有。
 * @param {HostFilterConfig} filter
 * @returns {{match(name:string):HostFilterVerdict|null}}
 */
export function compileHostFilter(filter = {}) {
  const lists = {};
  for (const rule of ['allow', 'deny']) {
    const raw = filter?.[rule] ?? [];
    if (!Array.isArray(raw)) {
      throw new DshError('VALIDATION', `hostFilter.${rule} 须为数组`);
    }
    if (raw.length > HOST_FILTER_LIMITS.maxPatterns) {
      throw new DshError('VALIDATION', `hostFilter.${rule} 最多 ${HOST_FILTER_LIMITS.maxPatterns} 条，收到 ${raw.length}`);
    }
    lists[rule] = raw.map((pattern, i) => {
      const why = checkHostPattern(pattern);
      if (why) throw new DshError('VALIDATION', `hostFilter.${rule}[${i}] ${why}`);
      return { pattern, re: new RegExp(`^(?:${pattern})$`, 'i') };
    });
  }

  return {
    /**
     * @param {string} name
     * @returns {HostFilterVerdict|null} null = 放行
     */
    match(name) {
      const target = String(name ?? '');
      for (const { pattern, re } of lists.deny) {
        if (re.test(target)) return { rule: 'deny', pattern };
      }
      if (lists.allow.length === 0) return null;
      // 白名单一旦非空就是「只认这些」；给出挡下它的那条规则里最像的一条没有意义，
      // 报第一条即可——人要看的是「白名单没放它进来」这件事
      return lists.allow.some(({ re }) => re.test(target))
        ? null
        : { rule: 'allow', pattern: lists.allow[0].pattern };
    },
  };
}

/** 判定原因的人话（页面、CLI、事件日志共用一套口径）。 */
export function hostFilterReason(verdict) {
  if (!verdict) return null;
  return verdict.rule === 'deny'
    ? `命中黑名单 ${verdict.pattern}`
    : `不在白名单内（白名单如 ${verdict.pattern}）`;
}
