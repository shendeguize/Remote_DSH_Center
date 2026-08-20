/**
 * manager 状态卡（10 §3.6 / UI-16）。前台模式的「不支持自我重启」不在前端预判，
 * 由后端错误 detail 呈现。
 */

import { button, clear, el, fmtDuration, text } from '../utils.js';

const MODE_LABEL = { foreground: '前台', background: '后台', launchd: 'launchd 托管' };

export function createManagerCard({ store, actions }) {
  const dl = el('dl.kv');
  const modeBadge = el('span.mode-badge', { text: '—' });
  const restartBtn = button('重启 manager', {
    variant: 'danger',
    compact: false,
    onClick: () => actions.restartManager(),
  });

  const root = el('article.card.manager-card', {}, [
    el('header.card-header', {}, [el('h2', { text: 'Manager' }), modeBadge]),
    dl,
    el('footer.card-footer', {}, [
      restartBtn,
      el('a.link', { href: '#/setup', text: '重新配置' }),
    ]),
  ]);

  function render() {
    const info = store.state.manager.info;
    clear(dl);
    if (!info) {
      dl.append(el('p.empty-hint', { text: '正在获取 manager 信息…' }));
      return;
    }
    modeBadge.textContent = MODE_LABEL[info.mode] ?? info.mode;
    const counts = info.hostCounts ?? {};
    for (const [k, v] of [
      ['版本', text(info.version)],
      ['PID', text(info.pid)],
      ['监听端口', text(info.port)],
      ['已运行', fmtDuration(info.uptimeMs)],
      ['主机', `${counts.total ?? 0} 台（运行 ${counts.running ?? 0} / 重连 ${counts.degraded ?? 0} / 异常 ${counts.crashed ?? 0}）`],
    ]) {
      dl.append(el('dt', { text: k }), el('dd', { text: v }));
    }

    const pending = store.isPending('manager:restart');
    restartBtn.disabled = pending || !store.canWrite();
    restartBtn.textContent = pending ? '正在重启…' : '重启 manager';
  }

  const offs = [
    store.on('manager:changed', render),
    store.on('pending:changed', render),
    store.on('connection:changed', render),
  ];
  render();

  return {
    root,
    destroy() {
      for (const off of offs) off();
    },
  };
}
