/**
 * 展示层纯函数 + 极简 DOM 助手（10 §1.2 状态语义表在此落地）。
 * 纯函数部分不触 DOM，可被 node:test 直接 import（14 §4）。
 */

/** phase → 文案与样式（颜色之外必须有文本，10 §1.2）。 */
export const PHASE_META = Object.freeze({
  running: { label: '运行中', tone: 'running', dot: 'solid' },
  degraded: { label: '隧道重连中', tone: 'degraded', dot: 'pulse' },
  crashed: { label: '进程异常退出', tone: 'crashed', dot: 'solid' },
  ready: { label: '可拉起', tone: 'ready', dot: 'hollow' },
  starting: { label: '启动中', tone: 'starting', dot: 'blink' },
  no_dsh: { label: '未安装/未配置', tone: 'neutral', dot: 'none' },
  unreachable: { label: 'SSH 不可达', tone: 'neutral', dot: 'none' },
  unknown: { label: '等待探测', tone: 'neutral', dot: 'none' },
});

export function phaseMeta(phase) {
  return PHASE_META[phase] ?? { label: phase ?? '—', tone: 'neutral', dot: 'none' };
}

const NO_DSH_REASON = { 'missing-bin': '远端未安装 dsh', 'no-web-profile': 'dsh 缺 web profile' };

/** 状态徽章下方的一行补充说明（缺失原因、挂起原因、orphaned…）。 */
export function phaseHint(host) {
  if (!host) return '';
  if (host.phase === 'no_dsh') return NO_DSH_REASON[host.probe?.noDshReason] ?? '';
  if (host.phase === 'unreachable') return host.probe?.errorSummary ?? '';
  if (host.tunnel?.suspendedReason === 'forward-disabled') return '远端禁止端口转发，已暂停重连';
  if (host.tunnel?.suspendedReason === 'local-port-busy') return '本机端口被占，已暂停重连';
  if (host.phase === 'degraded' && host.tunnel) return `重连尝试 ${host.tunnel.reconnectAttempt}`;
  return '';
}

export const DASH = '—';

export function text(value) {
  if (value === null || value === undefined || value === '') return DASH;
  return String(value);
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return DASH;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天 ${h}小时`;
  if (h > 0) return `${h}小时 ${m}分`;
  if (m > 0) return `${m}分 ${s % 60}秒`;
  return `${s}秒`;
}

/** 事件面板与探测时间用；只显示时钟部分，日期靠 title 补齐。 */
export function fmtClock(iso) {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

export function fmtAgo(iso, now = Date.now()) {
  if (!iso) return DASH;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return DASH;
  return `${fmtDuration(now - t)}前`;
}

/** dsh 列文案：路径与版本都可能缺，不从主机名推断。 */
export function dshSummary(host) {
  const probe = host?.probe;
  if (!probe) return { line1: DASH, line2: '' };
  return {
    line1: text(probe.version),
    line2: probe.dshPath ? probe.dshPath : (NO_DSH_REASON[probe.noDshReason] ?? ''),
  };
}

/** 映射列：只用后端下发的 mappedUrl / tunnel.localPort，不猜端口。 */
export function mappingSummary(host) {
  if (host?.mappedUrl) return { line1: `127.0.0.1:${host.tunnel.localPort}`, line2: `→ 远端 ${host.web?.port ?? host.effectiveRemotePort}`, url: host.mappedUrl };
  const reserved = host?.config?.localPort;
  return { line1: reserved ? `127.0.0.1:${reserved}（未连接）` : DASH, line2: '', url: null };
}

/** 手动实例（非受管）必须带锁：禁 stop/restart（README 不误杀契约）。 */
export function isManaged(host) {
  return host?.web?.startedByUs === true;
}

/**
 * 行内可用动作（10 §3.2）。connection/pending 的禁用在组件里叠加。
 * @returns {string[]}
 */
export function rowActions(host) {
  switch (host?.phase) {
    case 'ready':
      return ['start', 'probe'];
    case 'crashed':
      return isManaged(host) ? ['start', 'open', 'probe'] : ['start', 'probe'];
    case 'running':
      return isManaged(host) ? ['open', 'restart', 'stop'] : ['open', 'probe'];
    case 'degraded':
      return isManaged(host) ? ['open', 'reconnect', 'stop'] : ['open', 'probe'];
    case 'starting':
      return [];
    default:
      return ['probe'];
  }
}

export const ACTION_LABEL = Object.freeze({
  start: '拉起',
  stop: '关停',
  restart: '重启',
  reconnect: '重连',
  probe: '探测',
  open: '打开',
});

// ── DOM 助手（调用时才碰 document，import 本身在 node 下无副作用） ────────

/**
 * @param {string} tag 形如 'div.card.is-open' 或 'span'
 * @param {object} [props] className/textContent/dataset/attrs/on
 * @param {(Node|string|null)[]} [children]
 */
export function el(tag, props = {}, children = []) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length > 0) node.className = classes.join(' ');
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (key === 'class') node.className = node.className ? `${node.className} ${value}` : value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') throw new Error('禁止 innerHTML：一切动态文本走 textContent');
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'on') for (const [evt, fn] of Object.entries(value)) node.addEventListener(evt, fn);
    else if (key === 'disabled' || key === 'hidden' || key === 'checked') node[key] = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}

/** 状态圆点 + 文本（颜色不单独承载语义）。 */
export function phaseBadge(phase) {
  const meta = phaseMeta(phase);
  return el('span.phase-badge', { dataset: { tone: meta.tone } }, [
    el('span.status-dot', { dataset: { dot: meta.dot } }),
    el('span', { text: meta.label }),
  ]);
}

export function button(label, { onClick, variant = 'default', disabled = false, title = null, compact = true } = {}) {
  return el(`button.btn${compact ? '.btn-compact' : ''}`, {
    type: 'button',
    class: `btn-${variant}`,
    text: label,
    title,
    disabled,
    on: onClick ? { click: onClick } : undefined,
  });
}

/** 复制到剪贴板（无 clipboard 权限时退回临时 textarea）。 */
export async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand?.('copy') ?? false;
    ta.remove();
    return ok;
  }
}
