/**
 * 极简 DOM 垫片（14 §4）：让整套原生前端能在 node:test 里真挂载一次。
 *
 * 目标不是实现 DOM，而是覆盖本项目用到的那一小撮 API——足以在无浏览器的 CI 里
 * 抓出「组件构造/渲染路径抛异常」「事件没接上」这类回归。渲染样式、布局一概不管。
 */

const VOID_TAGS = new Set(['input', 'iframe']);

class FakeNode {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
  }

  get children() {
    return this.childNodes.filter((n) => n instanceof FakeElement);
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      const child = node instanceof FakeNode ? node : new FakeText(String(node));
      child.parentNode?.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i !== -1) this.childNodes.splice(i, 1);
    child.parentNode = null;
    // 真浏览器里，被移除的子树若含焦点，焦点就落回 body。垫片不照做的话，
    // 「重渲染把焦点甩没了」这类缺陷在单测里根本看不见。
    if (child.contains?.(document.activeElement)) document.activeElement = document.body;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) return;
    const i = parent.childNodes.indexOf(this);
    node.parentNode?.removeChild(node);
    node.parentNode = parent;
    parent.childNodes.splice(i, 1, node);
    this.parentNode = null;
    if (this.contains?.(document.activeElement)) document.activeElement = document.body;
  }

  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    this.append(...nodes);
  }

  contains(node) {
    if (node === this) return true;
    return this.childNodes.some((c) => c instanceof FakeNode && c.contains(node));
  }
}

class FakeText extends FakeNode {
  constructor(data) {
    super();
    this.data = data;
  }

  get textContent() {
    return this.data;
  }

  set textContent(v) {
    this.data = String(v);
  }
}

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
  }

  get set() {
    return new Set(this.owner.className.split(/\s+/).filter(Boolean));
  }

  write(set) {
    this.owner.className = [...set].join(' ');
  }

  add(...names) {
    const s = this.set;
    for (const n of names) s.add(n);
    this.write(s);
  }

  remove(...names) {
    const s = this.set;
    for (const n of names) s.delete(n);
    this.write(s);
  }

  contains(name) {
    return this.set.has(name);
  }

  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : Boolean(force);
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.localName = tag;
    this.className = '';
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      // 真 DOM 的 value 恒为字符串；组件常直接赋数字，这里必须同样强制转换
      let value = '';
      Object.defineProperty(this, 'value', {
        get: () => value,
        set: (v) => { value = v === null || v === undefined ? '' : String(v); },
        enumerable: true,
      });
      this.checked = false;
      this.type = 'text';
    }
  }

  get options() {
    return this.children.filter((c) => c.localName === 'option');
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(v) {
    this.childNodes = [];
    if (v !== '' && v !== null && v !== undefined) this.append(new FakeText(String(v)));
  }

  setAttribute(name, value) {
    if (name === 'class') {
      this.className = value;
      return;
    }
    this.attributes.set(name, String(value));
    if (name === 'hidden') this.hidden = true;
    if (name === 'src' || name === 'href' || name === 'value' || name === 'id' || name === 'type' || name === 'title') {
      this[name] = String(value);
    }
  }

  getAttribute(name) {
    if (name === 'class') return this.className;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return name === 'class' ? this.className !== '' : this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'hidden') this.hidden = false;
  }

  addEventListener(type, fn) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(event) {
    const ev = { target: this, preventDefault() {}, stopPropagation() {}, ...event };
    for (const fn of [...(this.listeners.get(ev.type) ?? [])]) fn(ev);
    return true;
  }

  /** 组件里只用到 click/change/submit 等直接派发，无需真冒泡。 */
  click() {
    return this.dispatchEvent({ type: 'click' });
  }

  focus() {
    document.activeElement = this;
  }

  blur() {
    if (document.activeElement === this) document.activeElement = document.body;
  }

  /**
   * 垫片没有布局，滚不动真东西——记一笔就够了。
   * 判据是「有没有对着正确的元素滚」（标签栏跟随，issue #25），
   * 「滚了多少像素」得靠真浏览器（ui-smoke S11）。
   */
  scrollIntoView(opts) {
    document.scrollCalls.push({ node: this, opts });
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  matches(selector) {
    return matchSelector(this, selector);
  }

  /** 往上找最近的匹配祖先（含自身），语义同浏览器。 */
  closest(selector) {
    for (let n = this; n; n = n.parentNode) {
      if (n instanceof FakeElement && matchSelector(n, selector)) return n;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** 支持后代选择符（空格分隔），如 '.host-table tbody tr'。 */
  querySelectorAll(selector) {
    const steps = selector.trim().split(/\s+/);
    let level = [this];
    for (const step of steps) {
      const next = [];
      for (const scope of level) {
        const walk = (node) => {
          for (const child of node.children) {
            if (matchSelector(child, step)) next.push(child);
            walk(child);
          }
        };
        walk(scope);
      }
      level = next;
    }
    return level;
  }

  get outerText() {
    return this.textContent;
  }
}

const TOKEN_RE = /[a-zA-Z][\w-]*|\.[\w-]+|#[\w-]+|\[[^\]]*\]|:not\(:disabled\)|:disabled/g;

/** 支持 `tag`、`.class`、`[attr="v"]`、`:not(:disabled)` 的组合，够本项目用。 */
function matchSelector(node, selector) {
  for (const part of selector.trim().match(TOKEN_RE) ?? []) {
    if (part.startsWith('.')) {
      if (!node.classList.contains(part.slice(1))) return false;
    } else if (part.startsWith('#')) {
      if (node.id !== part.slice(1)) return false;
    } else if (part.startsWith('[')) {
      const m = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(part);
      if (!m) return false;
      const [, name, value] = m;
      // 真 DOM 里 input.type 等反射属性与同名 attribute 互通；垫片这边两处都查，
      // 否则 `input[type="text"]` 这类选择器会在属性未显式 setAttribute 时漏掉
      const actual = name.startsWith('data-')
        ? node.dataset[name.slice(5)]
        : (node.hasAttribute(name) ? node.getAttribute(name) : node[name]);
      if (actual === undefined || actual === null) return false;
      if (value !== undefined && String(actual) !== value) return false;
    } else if (part === ':not(:disabled)') {
      if (node.disabled) return false;
    } else if (part === ':disabled') {
      if (!node.disabled) return false;
    } else if (node.localName !== part) {
      return false;
    }
  }
  return true;
}

class FakeDocument extends FakeElement {
  constructor() {
    super('#document');
    this.body = new FakeElement('body');
    this.body.parentNode = this;
    this.childNodes.push(this.body);
    this.activeElement = this.body;
    /** scrollIntoView 的账本（见 FakeElement.scrollIntoView）。 */
    this.scrollCalls = [];
  }

  createElement(tag) {
    return new FakeElement(tag);
  }

  createTextNode(data) {
    return new FakeText(data);
  }

  getElementById(id) {
    return this.querySelector(`#${id}`);
  }

  execCommand() {
    return true;
  }
}

class FakeLocation {
  constructor(win) {
    this.win = win;
    this.hash = '';
    this.origin = 'http://127.0.0.1:7788';
    /** 跨 origin 跳转的落点（真浏览器会整页离开，测试里只记录）。 */
    this.replacedWith = null;
  }

  get href() {
    return this.replacedWith ?? `${this.origin}/${this.hash}`;
  }

  /** hash 的 setter 自己会派发 hashchange，这里只负责改值。 */
  replace(to) {
    if (to.startsWith('#')) {
      this.hash = to;
      return;
    }
    this.replacedWith = to;
    const frag = to.split('#')[1] ?? '';
    this.hash = frag ? `#${frag}` : '';
  }
}

class FakeWindow extends FakeElement {
  constructor() {
    super('#window');
    this.location = new FakeLocation(this);
  }
}

/**
 * 装上垫片，返回 restore。
 * @returns {{document:FakeDocument, window:FakeWindow, restore:()=>void}}
 */
export function installDom() {
  const doc = new FakeDocument();
  const win = new FakeWindow();

  const app = doc.createElement('div');
  app.setAttribute('id', 'app');
  doc.body.append(app);

  const globals = {
    document: doc,
    window: win,
    Node: FakeNode,
    HTMLElement: FakeElement,
    CSS: { escape: (s) => String(s).replace(/["\\]/g, '\\$&') },
  };
  const descriptors = {};
  for (const [key, value] of Object.entries(globals)) {
    descriptors[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  // node 自带 navigator（只有 getter），只补 clipboard 这一个用到的能力
  descriptors.navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
    writable: true,
  });

  // 页面里 location.hash = x 要触发 hashchange（真浏览器行为）
  let hash = '';
  Object.defineProperty(win.location, 'hash', {
    get: () => hash,
    set: (v) => {
      if (hash === v) return;
      hash = v;
      win.dispatchEvent({ type: 'hashchange' });
    },
  });

  return {
    document: doc,
    window: win,
    app,
    restore() {
      for (const [key, desc] of Object.entries(descriptors)) {
        if (desc === undefined) delete globalThis[key];
        else Object.defineProperty(globalThis, key, desc);
      }
    },
  };
}

/** 深度优先收集，测试里断言渲染结果用。 */
export function findAll(node, selector) {
  return node.querySelectorAll(selector);
}

export function textOf(node) {
  return node?.textContent ?? null;
}
