/**
 * 有界并发（扇出闸）。
 *
 * 为什么需要：一台 manager 管 N 台远端时，探测/恢复/自启这类「对每台各来一次 ssh」的
 * 动作，无闸就是 N 条 ssh 同时握手。远端 sshd 的 `MaxStartups` 出厂值是 `10:30:100`——
 * 未完成认证的连接超过 10 条起就按比例随机丢，到 100 条全丢；多台远端共用一台跳板机
 * （ProxyJump）时这个额度是**所有主机合起来**算的。被丢的那几台会以
 * `kex_exchange_identification: Connection closed by remote host` 收场，页面上表现为
 * 「随机几台不可达」，而它们其实好端端的。
 *
 * 语义与 `Promise.allSettled` 对齐：不短路、结果按入参顺序、单个任务抛错不影响其余。
 */

/**
 * @template T, R
 * @param {T[]} items
 * @param {(item:T, index:number)=>Promise<R>} fn
 * @param {number} limit 同时在飞的上限；<=0 或 >= items.length 时等价于全并发
 * @returns {Promise<PromiseSettledResult<R>[]>}
 */
export async function mapPool(items, fn, limit) {
  const results = new Array(items.length);
  if (items.length === 0) return results;

  const width = limit > 0 ? Math.min(limit, items.length) : items.length;
  let next = 0;

  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
