/**
 * Bounded cleanup planning for Center-owned test web instances.
 *
 * Planning is pure and never kills a process. Applying a plan is performed by
 * the existing launcher stop path, which retains its fingerprint guard.
 */

import crypto from 'node:crypto';

export const CLEANUP_RULES = Object.freeze([
  'owned-web',
  'test-workdir',
  'stale-age',
  'orphan-process',
]);
export const DEFAULT_CLEANUP_RULES = Object.freeze(['owned-web', 'test-workdir']);
export const DEFAULT_TEST_WORKDIR_PREFIXES = Object.freeze([
  '/home/caros/workspace/dsh_debug',
  '/tmp/dshc-accept-',
]);
export const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1000;

export function normalizeCleanupRules(value, fallback = DEFAULT_CLEANUP_RULES) {
  const rules = Array.isArray(value) ? value : fallback;
  const normalized = rules.map((rule) => String(rule).trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0 || normalized.some((rule) => !CLEANUP_RULES.includes(rule))) {
    throw new Error('unknown cleanup rule');
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('cleanup rules must not repeat');
  }
  return normalized;
}

function isTestWorkdir(workdir, prefixes) {
  return typeof workdir === 'string'
    && prefixes.some((prefix) => workdir === prefix || workdir.startsWith(`${prefix}/`));
}

function isOld(startedAt, now, staleAgeMs) {
  const timestamp = Date.parse(String(startedAt ?? ''));
  return Number.isFinite(timestamp) && now - timestamp >= staleAgeMs;
}

function fingerprintSummary(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

export function buildCleanupPlan(
  hosts,
  {
    rules = DEFAULT_CLEANUP_RULES,
    now = Date.now(), // 墙钟：与 ISO startedAt 比较的清理时间点。
    staleAgeMs = DEFAULT_STALE_AGE_MS,
    testWorkdirPrefixes = DEFAULT_TEST_WORKDIR_PREFIXES,
  } = {},
) {
  const selected = normalizeCleanupRules(rules);
  if (!Number.isFinite(now) || !Number.isFinite(staleAgeMs) || staleAgeMs < 0) {
    throw new Error('cleanup clock values are invalid');
  }
  const candidates = [];
  for (const host of hosts) {
    const web = host?.web;
    const workdir = web?.workdir ?? web?.cwd;
    const owned = web?.startedByUs === true
      && Number.isInteger(web.pid)
      && typeof web.cmdFingerprint === 'string'
      && web.cmdFingerprint !== '';
    const testDir = isTestWorkdir(workdir, testWorkdirPrefixes);
    const stale = isOld(web?.startedAt, now, staleAgeMs);
    // Ownership and a recognized test workdir are both mandatory. Rules only
    // narrow the candidate set; none may turn an arbitrary managed instance
    // into a killable process.
    const matches = owned && testDir && (
      selected.includes('owned-web')
      || selected.includes('test-workdir')
      || (selected.includes('stale-age') && stale)
    );
    if (matches) {
      candidates.push({
        host: host.name,
        pid: web.pid,
        port: Number.isInteger(web.port) ? web.port : null,
        rule: selected.find((rule) => (
          (rule === 'stale-age' && stale)
          || rule === 'test-workdir'
          || rule === 'owned-web'
        )) ?? 'owned-web',
        fingerprintSha12: fingerprintSummary(web.cmdFingerprint),
        startedByUs: true,
      });
    }
  }
  return candidates.sort((left, right) => (
    left.host.localeCompare(right.host) || left.pid - right.pid
  ));
}

