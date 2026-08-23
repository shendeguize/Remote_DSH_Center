/**
 * 统一错误形状（11 §7.1）。零依赖叶子模块：全库可 import，自身不 import 任何本地模块，
 * 故不参与依赖环（ENG-24 的防环 lint 对本文件豁免 lib 互不 import 规则）。
 */

/** 错误码 → 默认 HTTP 状态（11 §7.2）。 */
export const ERROR_HTTP_STATUS = Object.freeze({
  VALIDATION: 400,
  NOT_FOUND: 404,
  SETUP_REQUIRED: 409,
  PHASE_CONFLICT: 409,
  NOT_ALLOWED: 409,
  // 跨站防线（src/lib/origin-guard.js）：都是 403，且都在路由之前判掉
  FORBIDDEN_ORIGIN: 403,
  FORBIDDEN_HOST: 403,
  PORT_EXHAUSTED: 409,
  SSH_UNREACHABLE: 502,
  SSH_TIMEOUT: 504,
  LOCAL_TIMEOUT: 504,
  LOCAL_EXEC_FAILED: 500,
  LOCAL_COPY_FAILED: 500,
  LOCAL_HOST_EXISTS: 409,
  LOCAL_NAME_CONFLICT: 409,
  PROTO_PARSE: 500,
  SETTINGS_TOO_LARGE: 413,
  SETTINGS_BUSY: 409,
  SETTINGS_STALE: 409,
  SETTINGS_WRITE_FAILED: 500,
  SETTINGS_READ_FAILED: 500,
  SETTINGS_UNSUPPORTED: 501,
  SETTINGS_INVALID_UTF8: 422,
  LAUNCH_FAILED: 500,
  KILL_REFUSED: 409,
  TUNNEL_FORWARD_DISABLED: 500,
  TUNNEL_PORT_BUSY: 500,
  STATE_ILLEGAL_TRANSITION: 500,
  // 配置落盘失败（目录只读 / 磁盘满 / 卷被卸载）：改动整份放弃，内存不动
  CONFIG_WRITE_FAILED: 500,
  // config.json 被外部手改，内存那份已过期：拒写而不是拿旧值盖掉（冲突，非故障）
  CONFIG_STALE: 409,
  // pidfile 写不进（同上三种成因）：没有它谁也找不到这个 manager，只能硬失败
  PIDFILE_WRITE_FAILED: 500,
  // manager.log 开不出来：后台进程的 stdout/stderr 就指它，没有它等于没有现场
  LOGFILE_OPEN_FAILED: 500,
  INTERNAL: 500,
});

export class DshError extends Error {
  /**
   * @param {keyof typeof ERROR_HTTP_STATUS | string} code
   * @param {string} message 一句话摘要（用户可读，单行）
   * @param {{host?:string|null, detail?:string|null, cause?:Error}} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message, extra.cause ? { cause: extra.cause } : undefined);
    this.name = 'DshError';
    this.code = code;
    this.host = extra.host ?? null;
    this.detail = extra.detail ?? null;
  }

  get httpStatus() {
    return ERROR_HTTP_STATUS[this.code] ?? 500;
  }

  /** HTTP 响应体形状（13 §1.1）。 */
  toBody() {
    const body = { error: this.message, code: this.code };
    if (this.detail) body.detail = this.detail;
    return body;
  }
}

/** 把任意异常规整为 DshError（api/queue 边界用，11 §7.1）。 */
export function asDshError(err, fallbackCode = 'INTERNAL') {
  if (err instanceof DshError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new DshError(fallbackCode, message, {
    cause: err instanceof Error ? err : undefined,
    detail: err instanceof Error && err.stack ? err.stack : null,
  });
}
