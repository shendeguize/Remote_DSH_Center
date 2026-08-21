import test from 'node:test';
import assert from 'node:assert/strict';

import { createTailCapture } from '../../src/lib/capture.js';

test('没超上限时原样还回来，不记丢弃', () => {
  const cap = createTailCapture(100);
  cap.push('abc');
  cap.push('def');
  assert.equal(cap.text(), 'abcdef');
  assert.equal(cap.dropped(), 0);
});

test('超上限留尾不留头：最后一段一定完整', () => {
  const cap = createTailCapture(10);
  cap.push('0123456789');
  cap.push('ABCDE');
  assert.equal(cap.text(), '56789ABCDE');
  assert.equal(cap.dropped(), 5);
});

test('单块就超上限：切掉块内的头', () => {
  const cap = createTailCapture(4);
  cap.push('abcdefghij');
  assert.equal(cap.text(), 'ghij');
  assert.equal(cap.dropped(), 6);
});

test('反复推进不许让内存跟着涨（账本自身要有界）', () => {
  const cap = createTailCapture(1024);
  for (let i = 0; i < 5_000; i += 1) cap.push('x'.repeat(512));
  assert.equal(cap.text().length, 1024);
  assert.equal(cap.dropped(), 5_000 * 512 - 1024);
  assert.ok(cap.chunkCount() <= 4, `账本里不许攒着已经没用的块，实得 ${cap.chunkCount()} 块`);
});

test('cap<=0 视为不封顶（调用方明确要全量的场合）', () => {
  const cap = createTailCapture(0);
  cap.push('a'.repeat(5_000));
  assert.equal(cap.text().length, 5_000);
  assert.equal(cap.dropped(), 0);
});

test('空推进与空收场都不许炸', () => {
  const cap = createTailCapture(8);
  assert.equal(cap.text(), '');
  cap.push('');
  assert.equal(cap.text(), '');
  assert.equal(cap.dropped(), 0);
});

test('尾部恰好等于上限：一个字节都不该丢', () => {
  const cap = createTailCapture(6);
  cap.push('abc');
  cap.push('def');
  assert.equal(cap.text(), 'abcdef');
  assert.equal(cap.dropped(), 0);
});
