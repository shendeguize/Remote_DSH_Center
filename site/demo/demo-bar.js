/**
 * demo 控制栏（站点自己的 UI，绝不混进管理台 DOM）。
 *
 * 三件事：自动演播（带字幕讲解「真实场景此处发生了什么」）、
 * 手动故障注入（断隧道 / 杀远端进程）、重置与首启引导入口。
 *
 * 演播只是「定时调假 manager 的 API + 换字幕」——和观众自己点按钮走的是
 * 同一套状态机，所以随时打断、随便乱点都不会让 demo 进入不一致的状态。
 */

import { DEMO_SCRIPT } from './demo-data.js';

const FAST_SCALE = 0.12;

/** 演播动作 → 对 manager 的一次调用。返回 false 表示「当前状态下跳过这步」。 */
export function runAction(action, { manager, win }) {
  if (!action) return true;
  const [kind, name] = action.split(':');
  switch (kind) {
    case 'probe-all':
      manager.probeAll();
      return true;
    case 'start': {
      const host = manager.getHost(name);
      if (host?.phase === 'running') return false;
      manager.startHost(name);
      return true;
    }
    case 'restart':
      manager.restartHost(name);
      return true;
    case 'drop':
      manager.injectTunnelDrop(name);
      return true;
    case 'crash':
      manager.injectCrash(name);
      return true;
    case 'open':
      win.location.hash = `#/host/${encodeURIComponent(name)}`;
      return true;
    case 'dashboard':
      win.location.hash = '#/';
      return true;
    default:
      return false;
  }
}

/** 故障注入的目标：优先当前正在看的主机，否则第一台还活着的。 */
export function pickTarget(hosts, routeHash) {
  const m = /^#\/host\/(.+)$/.exec(routeHash ?? '');
  const current = m ? decodeURIComponent(m[1]) : null;
  const alive = hosts.filter((h) => ['running', 'degraded'].includes(h.phase));
  const onRoute = alive.find((h) => h.name === current);
  return onRoute ?? alive[0] ?? null;
}

export function mountDemoBar({ manager, win = globalThis, fast = false } = {}) {
  const doc = win.document;
  const scale = fast ? FAST_SCALE : 1;

  const bar = doc.createElement('div');
  bar.className = 'demo-bar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'demo 控制栏');

  const caption = doc.createElement('p');
  caption.className = 'demo-caption';
  const note = doc.createElement('p');
  note.className = 'demo-note';

  const captionBox = doc.createElement('div');
  captionBox.className = 'demo-captions';
  captionBox.append(caption, note);

  const actions = doc.createElement('div');
  actions.className = 'demo-actions';

  const mkBtn = (label, { primary = false, onClick, title = null } = {}) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = `demo-btn${primary ? ' is-primary' : ''}`;
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    actions.append(b);
    return b;
  };

  const home = doc.createElement('a');
  home.className = 'demo-btn is-link';
  home.href = '../';
  home.textContent = '← 项目主页';

  const playBtn = mkBtn('▶ 自动演播', { primary: true, onClick: () => (playing ? stop('已停止演播。所有按钮仍然可用。') : play()) });
  const dropBtn = mkBtn('断开隧道', { onClick: () => inject('drop') });
  const crashBtn = mkBtn('杀掉远端进程', { onClick: () => inject('crash') });
  const resetBtn = mkBtn('重置', { onClick: () => reset() });
  const setupBtn = mkBtn('体验首启引导', {
    title: '重新加载 demo 并进入未初始化状态',
    onClick: () => { win.location.href = `${win.location.pathname}?setup`; },
  });
  actions.append(home);

  bar.append(captionBox, actions);
  doc.body.append(bar);

  // ── 状态与渲染 ──────────────────────────────────────────────────────
  let playing = false;
  let token = 0;
  let hosts = [];

  function say(text, hint = '') {
    caption.textContent = text;
    note.textContent = hint;
  }

  function syncButtons() {
    const target = pickTarget(hosts, win.location.hash);
    dropBtn.disabled = !target || target.phase !== 'running';
    crashBtn.disabled = !target;
    dropBtn.textContent = target ? `断开隧道（${target.name}）` : '断开隧道';
    crashBtn.textContent = target ? `杀掉远端进程（${target.name}）` : '杀掉远端进程';
    playBtn.textContent = playing ? '■ 停止演播' : '▶ 自动演播';
  }

  function inject(kind) {
    const target = pickTarget(hosts, win.location.hash);
    if (!target) return;
    stop();
    try {
      if (kind === 'drop') {
        manager.injectTunnelDrop(target.name);
        say(`已断开 ${target.name} 的隧道。`, '真实环境：ssh 子进程退出，manager 按 1/2/4/8/16/30s 退避重连；页面内容留着不重载。');
      } else {
        manager.injectCrash(target.name);
        say(`已杀掉 ${target.name} 的远端 dsh web。`, '真实环境：巡检发现记录的 PID 不见了，判 crashed，需人工重启；重启后 iframe 重载一次。');
      }
    } catch (err) {
      say(`这步做不了：${err.message}`, '状态机不允许当前状态执行该操作——真实环境同样会拒绝。');
    }
  }

  function reset() {
    stop();
    manager.reset({ mode: 'dashboard' });
    win.location.hash = '#/';
    say('已重置到初始状态。', '四台假主机：一台在跑、一台待拉起、一台没配 dsh、一台连不上。');
  }

  const sleep = (ms) => new Promise((r) => { setTimeout(r, Math.max(1, Math.round(ms))); });

  function stop(message = null) {
    playing = false;
    token += 1;
    if (message) say(message);
    syncButtons();
  }

  async function play() {
    playing = true;
    const mine = (token += 1);
    syncButtons();
    manager.reset({ mode: 'dashboard' });
    win.location.hash = '#/';

    for (const step of DEMO_SCRIPT) {
      if (!playing || token !== mine) return;
      say(step.caption, step.note);
      try {
        runAction(step.action, { manager, win });
      } catch (err) {
        say(`${step.caption}（这步被状态机拒绝：${err.message}）`, step.note);
      }
      // eslint-disable-next-line no-await-in-loop -- 演播就是顺序的
      await sleep(step.holdMs * scale);
    }
    if (token !== mine) return;
    playing = false;
    say('演示结束 —— 现在换你来点。', '表里每个按钮、抽屉里的每项配置都是真的可用，改坏了按「重置」。');
    syncButtons();
  }

  manager.subscribe((type, data) => {
    if (type === 'snapshot') hosts = data.hosts;
    else if (type === 'host-changed') {
      hosts = [...hosts.filter((h) => h.name !== data.host.name), data.host].sort((a, b) => a.name.localeCompare(b.name));
    } else return;
    syncButtons();
  });
  win.addEventListener('hashchange', syncButtons);

  say('这个 demo 跑的是产品前端本体，后端换成了浏览器里的假 manager。', '点「自动演播」看一遍完整流程，或直接自己动手。');
  syncButtons();

  return {
    bar, play, stop, reset, syncButtons, get playing() { return playing; },
  };
}
