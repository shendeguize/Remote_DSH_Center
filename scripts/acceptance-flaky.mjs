/**
 * 真机验收的有限重试登记。
 *
 * 未登记的步骤绝不自动重试；登记只吸收已知的瞬时 transport/launchd 噪声，
 * 不把所有失败都变成“第二次碰巧通过”。
 */

export const FLAKY_RETRIES = Object.freeze({
  'IT-03': 1,
  'IT-06': 1,
  'IT-11': 1,
});
