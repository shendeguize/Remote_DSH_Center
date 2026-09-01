import { api } from '../api.js';
import { button, clear, el } from '../utils.js';

/** On-demand, read-only fleet view. Results stay in the page, never config/state.json. */
export function createFleetAnalysis({ store }) {
  const title = el('h3', { text: '舰队会话分析' });
  const status = el('p', { text: '按需分析：读取各主机 Sidecar 的确定性聚类。' });
  const report = el('p.analysis-report', { hidden: true });
  const list = el('ul.analysis-clusters');
  const run = button('分析', {
    variant: 'primary',
    onClick: async () => {
      if (!store.canWrite() || busy) return;
      busy = true;
      run.disabled = true;
      status.textContent = '正在采集聚类并生成本机摘要…';
      clear(list);
      report.hidden = true;
      try {
        const result = await api.fleetAnalysis();
        render(result);
      } catch (error) {
        status.textContent = `分析失败：${error.message}`;
      } finally {
        busy = false;
        run.disabled = !store.canWrite();
      }
    },
  });
  let busy = false;

  function render(result) {
    const rows = Array.isArray(result?.clusters) ? result.clusters : [];
    status.textContent = `${result?.cached ? '使用缓存' : '刚刚完成'}：${rows.length} 个聚类（${result?.generatedAt ?? '时间未知'}）`;
    for (const row of rows) {
      const hosts = Array.isArray(row.hosts) ? row.hosts.join(', ') : '';
      list.append(el('li', {}, [
        el('strong', { text: `${row.project ?? 'unknown'} · ${row.agent ?? 'unknown'}` }),
        el('span', { text: ` ${row.model ?? 'unknown'} × ${row.count ?? 0}${hosts ? ` · ${hosts}` : ''}` }),
      ]));
    }
    if (rows.length === 0) list.append(el('li.empty-hint', { text: '没有可展示的聚类。' }));
    if (result?.report) {
      report.hidden = false;
      report.textContent = `本机摘要：${result.report}`;
    }
    if (result?.partial) {
      const details = (result.failures ?? []).map((item) => item.detail).filter(Boolean).join('；');
      status.textContent += `（部分能力不可用${details ? `：${details}` : ''}）`;
    }
  }

  return {
    root: el('section.card.fleet-analysis', {}, [
      el('div.card-header', {}, [title, run]),
      status,
      report,
      list,
    ]),
  };
}

