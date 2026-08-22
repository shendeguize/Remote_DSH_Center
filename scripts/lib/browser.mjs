/**
 * 无头浏览器驱动（极简 CDP 客户端 + Chrome 启动器）。
 *
 * 原先这些代码长在 scripts/ui-smoke.mjs 里，站点截图（site-shots）与 demo 冒烟
 * （site-check）也要用同一套，就抽到这里——三个脚本共用一个 CDP 实现，
 * 免得哪天 Chrome 行为变了要改三处。
 *
 * 零依赖：WebSocket 用 Node 22 内置的全局实现。
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** 显式指定优先；否则按 mac / linux 常见落点找，找不到就返回 null（由调用方决定跳过还是报错）。 */
export function findChrome({ env = process.env, exists = fs.existsSync } = {}) {
  const candidates = [
    env.DSHC_CHROME,
    env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter(Boolean);
  return candidates.find((p) => exists(p)) ?? null;
}

export class Cdp {
  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`CDP 连接失败：${wsUrl}`)), { once: true });
    });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (!p) return;
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
        return;
      }
      for (const fn of this.handlers.get(msg.method) ?? []) fn(msg.params);
    });
  }

  send(method, params = {}) {
    const id = (this.seq += 1);
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      // 超时定时器 settle 时必须清掉（issue #112）：不清的话每发一条就多留一个 20s
      // 的活句柄，一趟冒烟发上千条，跑完还得空等最后一批到点——实测收尾残着 25 个。
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`${method} 超时`));
      }, 20_000);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  on(method, fn) {
    const set = this.handlers.get(method) ?? new Set();
    set.add(fn);
    this.handlers.set(method, set);
  }

  /** 在页面里跑一段函数体，返回其 JSON 值；异常直接抛到这边。 */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`页面内异常：${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result.value;
  }

  async waitFor(expression, label, { timeoutMs = 15_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- 轮询真浏览器
      if (await this.eval(`return Boolean(${expression});`)) return;
      if (Date.now() > deadline) throw new Error(`页面等待超时：${label}`);
      // eslint-disable-next-line no-await-in-loop -- 同上
      await sleep(50);
    }
  }

  /**
   * 键盘事件要 rawKeyDown + keyUp 成对，否则页面收不到 keydown。
   *
   * 想让按钮**真被按下**，光有 rawKeyDown 不够：Enter 的原生激活走 keypress，
   * 而 `rawKeyDown` 按定义不产生字符事件，于是 Enter 永远只惊动监听器、按钮一动不动
   * （Space 反而能动——它的激活在 keyUp）。这种不对称会把产品的毛病和驱动的毛病搅在
   * 一起：实测里「焦点在清空键上按 Enter，条数不变」看着像产品 bug，其实是驱动没发全。
   * 所以带 text 的按键改用 `keyDown`。
   */
  async key(key, { code = key, keyCode = 0, modifiers = 0, text = DEFAULT_KEY_TEXT[key] } = {}) {
    const down = text ? 'keyDown' : 'rawKeyDown';
    for (const type of [down, 'keyUp']) {
      // eslint-disable-next-line no-await-in-loop -- 顺序发
      await this.send('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        modifiers,
        ...(text && type === down ? { text, unmodifiedText: text } : {}),
      });
    }
  }

  /**
   * 按下与抬起分开发。鼠标与 Space 的原生激活都在**抬起**那一刻，且要求这中间
   * 节点没被换掉——要验这条（issue #61）就得能在两者之间插事。
   */
  async keyHalf(type, key, { code = key, keyCode = 0, text = DEFAULT_KEY_TEXT[key] } = {}) {
    const isDown = type === 'down';
    await this.send('Input.dispatchKeyEvent', {
      type: isDown ? (text ? 'keyDown' : 'rawKeyDown') : 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      ...(text && isDown ? { text, unmodifiedText: text } : {}),
    });
  }

  /** @param {'down'|'up'} type */
  async mouseHalf(type, x, y) {
    await this.send('Input.dispatchMouseEvent', {
      type: type === 'down' ? 'mousePressed' : 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }

  /** 点击一个选择器命中的元素（用元素中心点发真鼠标事件）。 */
  async click(selector) {
    const box = await this.eval(`
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      node.scrollIntoView({ block: 'center' });
      const r = node.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    if (!box) throw new Error(`点击目标不存在：${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      // eslint-disable-next-line no-await-in-loop -- 按下与抬起要成对顺序发
      await this.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1,
      });
    }
  }

  close() {
    this.ws.close();
  }
}

/** 会触发原生激活的按键，其 text 必须带上（见 CdpSession#key）。 */
const DEFAULT_KEY_TEXT = { Enter: '\r', ' ': ' ', Space: ' ' };

export async function launchChrome({ headful = false, noSandbox = null, env = process.env } = {}) {
  const bin = findChrome({ env });
  if (!bin) throw new Error('找不到 Chrome/Chromium；用 DSHC_CHROME=<路径> 指定');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-chrome-'));
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-features=Translate,MediaRouter', '--disable-background-networking',
    'about:blank',
  ];
  if (!headful) args.unshift('--headless=new', '--disable-gpu', '--hide-scrollbars');
  // CI 容器里多半是 root，沙箱起不来（Chrome 直接退出）
  const needsNoSandbox = noSandbox ?? (process.getuid?.() === 0 || Boolean(env.CI));
  if (needsNoSandbox) args.unshift('--no-sandbox', '--disable-dev-shm-usage');

  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let closed = false;
  proc.once('close', () => { closed = true; });
  let stopPromise = null;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      const exited = closed || proc.exitCode !== null || proc.signalCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => {
          let timer;
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          proc.once('exit', done);
          timer = setTimeout(done, 2_000);
          proc.kill('SIGKILL');
        });

      // Chrome 的旁支可能继承这两根管道；主动断开，别让 PipeWrap 钉住调用方。
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      await exited;
      proc.unref();

      // 必须等主进程退出后再删：先删会与 Chrome 的最后一轮写盘打架，常见结果是
      // 内容删光了、顶层 dshc-chrome-* 又被重建，久而久之 /tmp 堆满空 profile。
      await sleep(50);
      try {
        fs.rmSync(profile, {
          recursive: true, force: true, maxRetries: 10, retryDelay: 100,
        });
      } catch {
        // 一个临时目录没删净，绝不该把通过的冒烟判红——交给系统清理
      }
    })();
    return stopPromise;
  };

  // 冷启动在共享 runner 上会被 IO 拖到二十几秒（实测 CI 上偶发超时判红，而本机从不复现）。
  // 放宽到 60s，并在超时时把 Chrome 自己的 stderr 一起交出来——否则只剩一句「没报出端口」，
  // 分不清是慢、是缺库、还是沙箱起不来。
  const startupMs = Number(env.DSHC_CHROME_TIMEOUT_MS) || 60_000;
  let wsUrl;
  try {
    wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const fail = (why) => reject(new Error(
        `${why}${buf.trim() ? `\nChrome 说：${buf.trim().split('\n').slice(-8).join('\n')}` : ''}`,
      ));
      const timer = setTimeout(
        () => fail(`Chrome 未在 ${Math.round(startupMs / 1000)}s 内报出调试端口`),
        startupMs,
      );
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk) => {
        buf += chunk;
        const m = buf.match(/ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+/);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      });
      // 挂 close 而不是 exit：exit 只说进程没了，stdio 可能还没读完——而「Chrome 退出」
      // 这条路上最有价值的信息（缺哪个库）恰恰在 stderr 里，抢在它到达之前报错等于白报。
      proc.once('close', (code) => {
        clearTimeout(timer);
        fail(`Chrome 退出（code ${code}）`);
      });
    });
  } catch (err) {
    await stop();
    throw err;
  }

  return {
    proc,
    wsUrl,
    bin,
    devtoolsBase: `http://${new URL(wsUrl).host}`,
    kill: stop,
  };
}

export function fetchText(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve(text));
    }).on('error', reject);
  });
}

export async function pageSession(chrome) {
  const list = JSON.parse(await fetchText(`${chrome.devtoolsBase}/json/list`));
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('Chrome 没有可用的 page target');
  return Cdp.attach(page.webSocketDebuggerUrl);
}

/** 截图落盘，返回文件绝对路径。 */
export async function captureScreenshot(cdp, outDir, name, { beyondViewport = true } = {}) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: beyondViewport });
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}
