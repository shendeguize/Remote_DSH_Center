/**
 * Hub、overflow 等消费者共享的主机展示语义。
 *
 * 本模块只处理 HostView 数据，不读取或创建 DOM。
 */

import {
  DASH,
  dshSummary,
  mappingSummary,
  phaseHint,
  phaseMeta,
} from './utils.js';

const LOCAL_PHASE_META = Object.freeze({
  unreachable: Object.freeze({ label: '本机不可用', tone: 'neutral', dot: 'none' }),
  no_dsh: Object.freeze({ label: '本机未安装或未配置', tone: 'neutral', dot: 'none' }),
});

const LOCAL_NO_DSH_HINT = Object.freeze({
  'missing-bin': '本机未安装 dsh',
  'no-web-profile': '本机 dsh 未配置 web profile',
});

function frozenCopy(value) {
  return Object.freeze({ ...value });
}

function isLocalHost(host) {
  return host?.local === true;
}

export function hostPhaseMeta(host) {
  const meta = isLocalHost(host)
    ? (LOCAL_PHASE_META[host?.phase] ?? phaseMeta(host?.phase))
    : phaseMeta(host?.phase);
  return frozenCopy(meta);
}

export function hostPhaseHint(host) {
  if (!isLocalHost(host)) return phaseHint(host);
  if (host?.phase === 'no_dsh') {
    return LOCAL_NO_DSH_HINT[host.probe?.noDshReason] ?? '';
  }
  if (host?.phase === 'unreachable') {
    return host.probe?.errorSummary || '本机命令执行失败';
  }
  return phaseHint(host);
}

export function hostDshSummary(host) {
  const summary = dshSummary(host);
  if (isLocalHost(host) && host?.phase === 'no_dsh') {
    return frozenCopy({ ...summary, line2: hostPhaseHint(host) });
  }
  return frozenCopy(summary);
}

export function hostMappingSummary(host) {
  if (!isLocalHost(host)) return frozenCopy(mappingSummary(host));
  if (host?.mappedUrl && host?.tunnel?.localPort != null) {
    return frozenCopy({
      line1: `本机 ${host.tunnel.localPort}`,
      line2: '直连 dsh web',
      url: host.mappedUrl,
    });
  }
  return frozenCopy({ line1: DASH, line2: '', url: null });
}

export function hostStatusText(host, { disabled = false } = {}) {
  return disabled ? '已禁用' : hostPhaseMeta(host).label;
}
