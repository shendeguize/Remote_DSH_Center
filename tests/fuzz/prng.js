/**
 * 种子化随机源（harness 支柱 C：测试可靠性）。
 *
 * 为什么自己写 PRNG：`Math.random()` 的种子不可控，随机测试一红就再也复现不出来，
 * 于是没人信它、最后被注释掉。这里的每一个例子都由 `(根种子, 目标名, 序号)` 唯一决定，
 * 失败信息里带的种子能逐字复现同一个输入——随机测试的全部价值都押在这一点上。
 *
 * 算法是 mulberry32：32 位状态、四则运算与位运算各几步，跨平台跨 Node 版本逐位一致
 * （不涉及浮点累加，`Math.imul` 是精确的 32 位乘法）。它的统计质量足够做输入生成，
 * 但**不是密码学安全**的——本目录只用它造测试输入，绝不用来造任何真实密钥或 token。
 */

/**
 * @param {number} seed 32 位无符号
 * @returns {() => number} [0,1) 均匀分布
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * 把任意几段标识揉成一个 32 位种子（FNV-1a）。
 * 目标名进种子，所以两个目标的第 7 例互不相同——否则同一串输入会被反复验，白花预算。
 * @param {...(string|number)} parts
 */
export function hashSeed(...parts) {
  let h = 0x811c_9dc5;
  for (const part of parts) {
    const text = `${part}\u0000`;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i) & 0xff;
      h = Math.imul(h, 0x0100_0193) >>> 0;
      h ^= text.charCodeAt(i) >>> 8;
      h = Math.imul(h, 0x0100_0193) >>> 0;
    }
  }
  return h >>> 0;
}

/** 生成器用的字符集。分开列是为了「按面挑毒」：shell 面和 JSON 面的毒不是一种。 */
export const ALPHABETS = Object.freeze({
  plain: 'abcdefghijklmnopqrstuvwxyz0123456789',
  safeName: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-',
  /** shell 元字符全家桶：引号、展开、重定向、分隔、通配。 */
  shell: 'abc012 \t\'"$`\\;|&<>(){}[]*?!#~=:,./%^@+-\n',
  /** JSON/HTTP 面的毒：控制字符、代理对边界、原型污染键名的零件。 */
  json: 'abc012 "\\/\b\f\n\r\t{}[]:,.-+eE0__proto__prototypeconstructor',
});

/** 逐个都出过事的 Unicode 形态。挑出来单列，因为随机采样几乎撞不上它们。 */
export const NASTY_CODEPOINTS = Object.freeze([
  '\u0000', // NUL：argv 的硬边界
  '\u0007', // BEL：终端控制
  '\u001b', // ESC：ANSI 转义序列的头
  '\u007f', // DEL
  '\u00a0', // 不换行空格：看起来是空格，不是空格
  '\u200b', // 零宽空格
  '\u200e', // 从左至右标记
  '\u202e', // 从右至左覆盖：能把显示出来的文件名整段反过来
  '\u0301', // 组合用锐音符：跟在别的字后面
  '\ufeff', // BOM
  '\uff0f', // 全角斜杠：路径判定的经典绕行
  '\ud83d\udca9', // 星平面（代理对）：按码位算长度和按 UTF-16 算长度会打架
  '\ud800', // 孤立高代理：不是合法标量值
  '\u0085', // NEL：某些实现当换行
]);

export class Rng {
  /** @param {number} seed */
  constructor(seed) {
    this.seed = seed >>> 0;
    this.next = mulberry32(this.seed);
  }

  float() {
    return this.next();
  }

  /** 闭区间 [min, max]。 */
  int(min, max) {
    if (max < min) throw new Error(`int 区间反了：${min}..${max}`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(p = 0.5) {
    return this.next() < p;
  }

  /** @template T @param {readonly T[]} items @returns {T} */
  pick(items) {
    if (items.length === 0) throw new Error('pick 拿到空表');
    return items[this.int(0, items.length - 1)];
  }

  /**
   * 加权挑选。生成器的分布得能调——不加权的话，「毒」字符在长串里几乎必然出现，
   * 反而测不到「正常输入不该被拦」那一半。
   * @template T @param {ReadonlyArray<readonly [number, T]>} table [权重, 值]
   * @returns {T}
   */
  pickWeighted(table) {
    const total = table.reduce((sum, [weight]) => sum + weight, 0);
    let dart = this.next() * total;
    for (const [weight, value] of table) {
      dart -= weight;
      if (dart < 0) return value;
    }
    return table[table.length - 1][1];
  }

  /** @template T @param {readonly T[]} items @returns {T[]} 新数组 */
  shuffle(items) {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** @param {{min?:number, max?:number, alphabet?:string}} [opts] */
  string({ min = 0, max = 16, alphabet = ALPHABETS.plain } = {}) {
    const len = this.int(min, max);
    let out = '';
    for (let i = 0; i < len; i += 1) out += alphabet[this.int(0, alphabet.length - 1)];
    return out;
  }

  /**
   * 混合毒串：多数字符来自给定字符集，少数来自 NASTY_CODEPOINTS。
   * @param {{min?:number, max?:number, alphabet?:string, nastyRate?:number,
   *   forbid?:readonly string[]}} [opts] forbid 里的字符一律不生成（如 argv 面禁 NUL）
   */
  nasty({
    min = 0, max = 24, alphabet = ALPHABETS.shell, nastyRate = 0.12, forbid = [],
  } = {}) {
    const banned = new Set(forbid);
    const pool = [...alphabet].filter((c) => !banned.has(c));
    const nasties = NASTY_CODEPOINTS.filter((c) => ![...c].some((ch) => banned.has(ch)));
    const len = this.int(min, max);
    let out = '';
    for (let i = 0; i < len; i += 1) {
      out += this.bool(nastyRate) && nasties.length > 0 ? this.pick(nasties) : this.pick(pool);
    }
    return out;
  }
}

/** 便捷入口：`rngFor(rootSeed, target, index)`。 */
export function rngFor(rootSeed, target, index) {
  return new Rng(hashSeed(rootSeed, target, index));
}
