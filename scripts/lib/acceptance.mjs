/**
 * 真机验收的通用地基：互斥、脱敏、报告与跨轮比较。
 *
 * 这个模块只服务于 scripts/ 下的操作员验收入口，不进入 src/ 产品运行时。
 * 真机证据默认写入 .local/，不得把密钥、完整主机名或会话标识写进报告。
 */

import fs from 'node:fs';
import path from 'node:path';

const SECRET_KEY = /(?:token|secret|password|passwd|private[_-]?key|authorization|cookie)/iu;
const SECRET_VALUE = /(?:Bearer\s+|-----BEGIN [^-]+ KEY-----|--?(?:token|secret|password)=)[^\s,;]+/giu;
const PATH_PART = /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|\/root)(?=\/|\s|$)/gu;

export function redact(value, { hostAliases = [] } = {}) {
  if (Array.isArray(value)) return value.map((item) => redact(item, { hostAliases }));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? '[REDACTED]' : redact(item, { hostAliases }),
    ]));
  }
  if (typeof value !== 'string') return value;
  let text = value.replaceAll(SECRET_VALUE, '[REDACTED]');
  for (const alias of hostAliases) {
    if (alias) text = text.split(alias).join('<host>');
  }
  return text.replaceAll(PATH_PART, '<home>');
}

export function evidenceId(now = new Date()) {
  return now.toISOString().replaceAll(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

export function acquireLock(lockPath, metadata = {}) {
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.mkdirSync(lockPath);
  } catch (error) {
    if (error.code === 'EEXIST') {
      let owner = null;
      try {
        owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
      } catch { /* stale or partially written owner */ }
      const detail = owner ? `（已有运行：${owner.pid ?? 'unknown'}）` : '（锁目录已存在）';
      throw new Error(`真机验收已被占用${detail}：${lockPath}`);
    }
    throw error;
  }
  fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...metadata,
  }, null, 2)}\n`, { mode: 0o600 });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.rmSync(lockPath, { recursive: true, force: true });
  };
}

export function compareEvidence(previous, current) {
  if (!previous) return { previous: null, regressions: [], improvements: [] };
  const oldCases = new Map((previous.cases ?? []).map((item) => [item.id, item]));
  const regressions = [];
  const improvements = [];
  for (const item of current.cases ?? []) {
    const old = oldCases.get(item.id);
    if (!old) continue;
    if (old.status === 'pass' && item.status !== 'pass') {
      regressions.push({ id: item.id, from: old.status, to: item.status, note: item.note });
    } else if (old.status !== 'pass' && item.status === 'pass') {
      improvements.push({ id: item.id, from: old.status, to: item.status });
    }
  }
  return { previous: previous.runId ?? null, regressions, improvements };
}

export function renderEvidenceMarkdown(report) {
  const lines = [
    `# 真机验收报告 — ${report.tier ?? 'full'}`,
    '',
    `- run: \`${report.runId}\``,
    `- started: ${report.startedAt}`,
    `- finished: ${report.finishedAt ?? '未结束'}`,
    `- host: \`${report.host}\``,
    `- result: **${report.ok ? 'PASS' : 'BLOCK/FAIL'}**`,
    report.drift?.length ? `- pin and rerun: \`${report.pinCommand ?? '请先恢复已知版本窗口后重跑'}\`` : '- pin and rerun: 不适用',
    '',
    '## 环境',
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| Center | ${report.versions?.center ?? 'unknown'} |`,
    `| dsh | ${report.versions?.remoteDsh ?? 'unknown'} |`,
    `| 重试总数 | ${report.retryCount ?? 0} |`,
    '',
    '## 用例',
    '',
    '| ID | 状态 | 耗时 | 重试 | 说明 |',
    '|---|---|---:|---:|---|',
  ];
  for (const item of report.cases ?? []) {
    lines.push(`| ${item.id} | ${item.status} | ${((item.ms ?? 0) / 1000).toFixed(1)}s | ${item.retries ?? 0} | ${item.note ?? ''} |`);
  }
  lines.push('', '## 漂移告警', '');
  if (report.drift?.length) {
    for (const item of report.drift) lines.push(`- ${item}`);
  } else {
    lines.push('- 无');
  }
  lines.push('', '## 跨轮比较', '');
  const diff = report.comparison;
  if (diff?.regressions?.length) {
    for (const item of diff.regressions) lines.push(`- 回归：${item.id} ${item.from} → ${item.to}`);
  } else {
    lines.push('- 未发现已知用例回归');
  }
  if (diff?.improvements?.length) {
    for (const item of diff.improvements) lines.push(`- 改善：${item.id} ${item.from} → ${item.to}`);
  }
  return `${lines.join('\n')}\n`;
}

export function writeEvidence(report, {
  directory,
  hostAliases = [],
  previous = null,
} = {}) {
  const safe = redact({
    ...report,
    comparison: compareEvidence(previous, report),
  }, { hostAliases });
  fs.mkdirSync(directory, { recursive: true });
  const jsonPath = path.join(directory, `${safe.runId}.json`);
  const markdownPath = path.join(directory, `${safe.runId}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(markdownPath, renderEvidenceMarkdown(safe), { mode: 0o600 });
  return { jsonPath, markdownPath, report: safe };
}

export function readLatestEvidence(directory) {
  let names = [];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch { return null; }
  if (names.length === 0) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, names.at(-1)), 'utf8'));
  } catch { return null; }
}
