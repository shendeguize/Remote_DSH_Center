/**
 * 批量配置同步的唯一规则源。
 *
 * 只复制「下一次拉起」使用的 profile；身份、纳管、自启、本机映射和运行态一律不碰。
 */

import { isDeepStrictEqual } from 'node:util';

import { DshError } from './lib/errors.js';

export const SYNC_PROFILE_FIELDS = Object.freeze([
  'remoteWebPort',
  'workdir',
  'inject.env',
  'inject.extraArgs',
  'inject.patches',
]);

function cloneInject(value) {
  return {
    env: { ...(value?.env ?? {}) },
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
