/**
 * 批量配置同步的唯一规则源。
 *
 * 只复制「下一次拉起」使用的 profile；身份、纳管、自启、本机映射和运行态一律不碰。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { DshError } from './lib/errors.js';

export const SYNC_PROFILE_FIELDS = Object.freeze([
  'remoteWebPort',
  'workdir',
  'inject.env',
  'inject.extraArgs',
  'inject.patches',
]);

const PREVIEW_TOKEN_VERSION = 'v1';
const PREVIEW_TOKEN_KEY = randomBytes(32);

function cloneInject(value) {
  return {
    env: { ...value?.env },
    extraArgs: [...(value?.extraArgs ?? [])],
    patches: [...(value?.patches ?? [])],
  };
}

export function syncProfileOf(hostConfig) {
  return {
    remoteWebPort: hostConfig?.remoteWebPort ?? null,
    workdir: hostConfig?.workdir ?? null,
    inject: cloneInject(hostConfig?.inject),
  };
}

function changedFields(source, target) {
  const changed = [];
  if (!isDeepStrictEqual(source.remoteWebPort, target.remoteWebPort)) changed.push('remoteWebPort');
  if (!isDeepStrictEqual(source.workdir, target.workdir)) changed.push('workdir');
  if (!isDeepStrictEqual(source.inject.env, target.inject.env)) changed.push('inject.env');
  if (!isDeepStrictEqual(source.inject.extraArgs, target.inject.extraArgs)) changed.push('inject.extraArgs');
  if (!isDeepStrictEqual(source.inject.patches, target.inject.patches)) changed.push('inject.patches');
  return changed;
}

function requireHost(config, name, role) {
  const hosts = config?.hosts;
  if (hosts === null || typeof hosts !== 'object' || !Object.hasOwn(hosts, name)) {
    throw new DshError('NOT_FOUND', `${role} ${name} 不存在`, { host: name });
  }
  const host = hosts[name];
  if (!host) throw new DshError('NOT_FOUND', `${role} ${name} 不存在`, { host: name });
  return host;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function previewTokenForPlan(config, plan) {
  const payload = {
    source: {
      name: plan.source,
      profile: syncProfileOf(requireHost(config, plan.source, '源主机')),
    },
    targets: plan.targets
      .map(({ name }) => ({
        name,
        profile: syncProfileOf(requireHost(config, name, '目标主机')),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
  const digest = createHmac('sha256', PREVIEW_TOKEN_KEY)
    .update('dsh-center/config-sync-preview/v1\0')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('base64url');
  return `${PREVIEW_TOKEN_VERSION}.${digest}`;
}

function tokensEqual(actual, expected) {
  if (typeof actual !== 'string') return false;
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

export function planConfigSync(config, { source, targets } = {}) {
  if (typeof source !== 'string' || source === '') {
    throw new DshError('VALIDATION', '请选择源主机');
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new DshError('VALIDATION', '至少选择一台目标主机');
  }
  if (new Set(targets).size !== targets.length) {
    throw new DshError('VALIDATION', '目标主机不能重复');
  }
  if (targets.includes(source)) {
    throw new DshError('VALIDATION', '源主机不能同时作为目标主机');
  }

  const profile = syncProfileOf(requireHost(config, source, '源主机'));
  const targetPlans = targets.map((name) => {
    const fields = changedFields(profile, syncProfileOf(requireHost(config, name, '目标主机')));
    return { name, changed: fields.length > 0, changedFields: fields };
  });

  return {
    source,
    profile,
    targets: targetPlans,
  };
}

export function createConfigSyncPreview(config, request) {
  const plan = planConfigSync(config, request);
  return {
    plan,
    previewToken: previewTokenForPlan(config, plan),
  };
}

export function requireConfigSyncPreview(config, request, previewToken) {
  const preview = createConfigSyncPreview(config, request);
  if (!tokensEqual(previewToken, preview.previewToken)) {
    throw new DshError(
      'CONFIG_STALE',
      '配置同步预览已过期或无效，请重新预览后再应用',
      { detail: '源主机或任一目标主机的同步 profile 可能已变化。' },
    );
  }
  return preview.plan;
}

export function applyConfigSync(draft, plan) {
  requireHost(draft, plan?.source, '源主机');
  const targets = (plan?.targets ?? []).map((targetPlan) => ({
    config: requireHost(draft, targetPlan.name, '目标主机'),
    plan: targetPlan,
  }));
  const changed = [];
  for (const { config: target, plan: targetPlan } of targets) {
    if (!targetPlan.changed) continue;
    target.remoteWebPort = plan.profile.remoteWebPort;
    target.workdir = plan.profile.workdir;
    target.inject = cloneInject(plan.profile.inject);
    changed.push(targetPlan.name);
  }
  return changed;
}
