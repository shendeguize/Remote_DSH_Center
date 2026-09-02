/**
 * 管理页布局契约：页头与主机卡内容同轴，并在窄屏稳定换行。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { mount } from './app-harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'web', 'style.css'), 'utf8');

function blocksFor(source, marker) {
  const blocks = [];
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf(marker, cursor);
    if (start === -1) break;
    const open = source.indexOf('{', start);
    assert.notEqual(open, -1, `${marker} 缺少左花括号`);

    let depth = 1;
    let close = open + 1;
    while (close < source.length && depth > 0) {
      if (source[close] === '{') depth += 1;
      if (source[close] === '}') depth -= 1;
      close += 1;
    }
    assert.equal(depth, 0, `${marker} 缺少右花括号`);
    blocks.push(source.slice(open + 1, close - 1));
    cursor = close;
  }

  return blocks;
}

function blockFor(source, selector) {
  const marker = `${selector} {`;
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(marker, cursor);
    if (start === -1) break;
    const lineStart = source.lastIndexOf('\n', start) + 1;
    if (source.slice(lineStart, start).trim() === '') {
      return blocksFor(source.slice(start), marker)[0];
    }
    cursor = start + marker.length;
  }
  assert.fail(`style.css 缺少 ${selector} 规则`);
}

function declaration(block, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`(?:^|[;\\n])\\s*${escaped}:\\s*([^;\\n}]+)`));
  assert.ok(match, `${property} 未声明在目标规则内`);
  return match[1].trim();
}

const compact = (value) => value.replace(/\s+/g, '');

test('卡片内缘由 border 与 inline padding token 唯一组合', () => {
  const root = blockFor(CSS, ':root');
  assert.equal(declaration(root, '--card-border-width'), '1px');
  assert.equal(declaration(root, '--card-padding-inline'), '14px');
  assert.equal(
    compact(declaration(root, '--card-content-inset')),
    'calc(var(--card-border-width)+var(--card-padding-inline))',
    '内容内缘必须由卡片边框与横向 padding 组合，不能另抄总像素值',
  );

  const card = blockFor(CSS, '.card');
  assert.equal(
    declaration(card, 'border'),
    'var(--card-border-width) solid var(--border)',
  );
  assert.match(declaration(card, 'padding'), /^12px\s+var\(--card-padding-inline\)$/);
  assert.doesNotMatch(card, /\b(?:1px|14px)\b/, '.card 不得保留 token 之外的重复尺寸');
});

test('管理页头宽屏同排靠右，并消费卡片内容内缘 token', () => {
  const cardHeader = blockFor(CSS, '.card-header');
  assert.equal(declaration(cardHeader, 'display'), 'flex');
  assert.equal(declaration(cardHeader, 'justify-content'), 'space-between');
  assert.doesNotMatch(cardHeader, /(?:padding-inline|flex-wrap)\s*:/,
    '管理页布局不能通过修改全局 .card-header 影响其他页面');

  const header = blockFor(CSS, '.view-dashboard > .manage-header');
  assert.equal(declaration(header, 'padding-inline'), 'var(--card-content-inset)');
  assert.equal(declaration(header, 'flex-wrap'), 'nowrap');

  const actions = blockFor(CSS, '.view-dashboard > .manage-header > .row-actions');
  assert.equal(declaration(actions, 'margin-left'), 'auto');
});

test('620px 以下页头动作独占一行且不撑宽文档', () => {
  const mobile = blocksFor(CSS, '@media (max-width: 620px)')
    .find((block) => block.includes('.view-dashboard > .manage-header'));
  assert.ok(mobile, '缺少管理页头的 620px 窄屏规则');

  const header = blockFor(mobile, '.view-dashboard > .manage-header');
  assert.equal(declaration(header, 'flex-wrap'), 'wrap');
  assert.equal(declaration(header, 'min-width'), '0');

  const actions = blockFor(mobile, '.view-dashboard > .manage-header > .row-actions');
  assert.equal(declaration(actions, 'width'), '100%');
  assert.equal(declaration(actions, 'min-width'), '0');
  assert.equal(declaration(actions, 'margin-left'), '0');
  assert.equal(declaration(actions, 'justify-content'), 'flex-start');

  const rowActions = blockFor(CSS, '.row-actions');
  assert.equal(declaration(rowActions, 'flex-wrap'), 'wrap');
  assert.equal(declaration(rowActions, 'gap'), '6px', '窄屏不得覆盖按钮间距');
  assert.doesNotMatch(actions, /gap\s*:/, '窄屏动作行应继承既有按钮 gap');
});

test('操作列的 flex 待在格子里面，td 保持表格单元格', () => {
  // display:flex 写在 td 上，这一格就不再是 table-cell：它不跟同行其他格拉平高度，
  // 自带的 border-bottom 于是比别人早二三十像素落笔，一行的分隔线断成错位两段。
  // 卡片头那个 .row-actions 是 div，flex 归它；表格里只能由内层包装消费。
  const shared = blockFor(CSS, '.row-actions');
  assert.equal(declaration(shared, 'display'), 'flex');

  const cell = blockFor(CSS, '.host-table .actions-cell');
  assert.doesNotMatch(cell, /display\s*:/, '操作格不得改 display，否则退出行高均衡');
  assert.equal(declaration(cell, 'white-space'), 'nowrap');
  assert.equal(declaration(cell, 'min-width'), '260px');

  const inner = blockFor(CSS, '.host-table .actions-cell > .row-actions');
  assert.equal(declaration(inner, 'flex-wrap'), 'nowrap', '行内按钮换行会把行高撑成两档');
  assert.doesNotMatch(CSS, /\.host-table \.row-actions\s*\{/,
    '不得再按表格后代改 .row-actions：那条规则当年就是落在 td 上的');
});

test('可排序表头与列内容压在同一条左边界上', () => {
  // .btn / .btn-compact 的 padding、border、color 都写在 .host-sort-button 之后，
  // 同优先级下后来者胜：这条规则必须靠 th 后代提权，否则可排序列的表头会比其余
  // 表头右移一个按钮内边距，也比它们亮一档。
  const sortButton = blockFor(CSS, '.host-table th .host-sort-button');
  assert.equal(declaration(sortButton, 'padding'), '0', '表头按钮的横向内边距会把标签推离列内容');
  assert.equal(declaration(sortButton, 'border'), '0');
  assert.equal(declaration(sortButton, 'font'), 'inherit');
  assert.equal(declaration(sortButton, 'color'), 'inherit', '表头颜色必须与不可排序的表头一致');
  assert.equal(declaration(sortButton, 'background'), 'none');

  const cells = blockFor(CSS, '.host-table th, .host-table td');
  assert.equal(declaration(cells, 'padding'), '8px 10px', '表头与单元格必须共用同一组内边距');

  // 排序方向的可见指示只能向右长，向左动一个像素就又破坏对齐
  assert.match(CSS, /\.host-table th \.host-sort-button\[aria-sort="asc"\]::after/);
  assert.match(CSS, /\.host-table th \.host-sort-button\[aria-sort="desc"\]::after/);
});

test('620px 以下双卡单列并允许卡片宽度链收缩', () => {
  const desktop = blockFor(CSS, '.side-by-side');
  assert.equal(
    declaration(desktop, 'grid-template-columns'),
    'repeat(auto-fit, minmax(320px, 1fr))',
    '宽屏仍须保留 320px auto-fit 双列行为',
  );
  const mobileStart = CSS.indexOf(
    '@media (max-width: 620px)',
    CSS.indexOf('.view-dashboard > .manage-header'),
  );
  assert.ok(
    CSS.indexOf('.side-by-side {') < mobileStart,
    '宽屏网格规则必须先于窄屏覆盖，避免同权重规则反向覆盖',
  );

  const card = blockFor(CSS, '.card');
  assert.equal(declaration(card, 'min-width'), '0');

  const mobile = blocksFor(CSS, '@media (max-width: 620px)')
    .find((block) => block.includes('.view-dashboard > .manage-header'));
  const sideBySide = blockFor(mobile, '.side-by-side');
  assert.equal(declaration(sideBySide, 'grid-template-columns'), 'minmax(0, 1fr)');
  assert.equal(declaration(sideBySide, 'min-width'), '0');
  assert.doesNotMatch(
    sideBySide,
    /calc\(|(?:^|[;\n])\s*(?:width|max-width)\s*:|\d+vw\b/,
    '窄屏覆盖应依靠网格收缩，不得另算视口与 view padding',
  );
});

test('模态层序与 toast 指针契约：scrim < drawer < toast < menu < dialog', () => {
  const root = blockFor(CSS, ':root');
  const z = (name) => Number(declaration(root, `--z-${name}`));
  const order = ['scrim', 'drawer', 'toast', 'menu', 'dialog'];

  for (let i = 1; i < order.length; i += 1) {
    const lower = order[i - 1];
    const upper = order[i];
    assert.ok(z(lower) < z(upper), `--z-${lower}(${z(lower)}) 必须低于 --z-${upper}(${z(upper)})`);
  }
  assert.equal(declaration(blockFor(CSS, '.drawer-scrim'), 'z-index'), 'var(--z-scrim)');
  assert.equal(declaration(blockFor(CSS, '.host-drawer'), 'z-index'), 'var(--z-drawer)');
  assert.equal(
    declaration(blockFor(CSS, '.toast'), 'pointer-events'),
    'auto',
    'toast 在抽屉或对话框打开时仍必须可以接收关闭/复制点击',
  );
});

test('#/manage 页头与主机卡是同一 dashboard 的直接子级', async (t) => {
  const { dom } = await mount(t, { hash: '#/manage' });
  const dashboard = dom.app.querySelector('.view-dashboard');
  const header = dashboard.querySelector('.manage-header');
  const hostTableCard = dashboard.querySelector('.host-table-card');

  assert.equal(dashboard.hidden, false);
  assert.equal(header.parentNode, dashboard);
  assert.equal(hostTableCard.parentNode, dashboard);
  assert.ok(
    dashboard.children.indexOf(header) < dashboard.children.indexOf(hostTableCard),
    '页头应直接位于主机卡之前，二者才能共享 dashboard 坐标系',
  );
});
