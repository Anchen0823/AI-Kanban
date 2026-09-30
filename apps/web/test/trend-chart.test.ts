import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TrendChart } from '../src/pages/Telemetry.js';

const days = [null, 10, null, null, 20, null].map((value, i) => ({ day: `2026-09-0${i + 1}`, value }));

test('trend connects across missing days at their original calendar positions', () => {
  const html = renderToStaticMarkup(createElement(TrendChart, { days, mode: 'area' }));
  const lines = [...html.matchAll(/<path d="([^"]+)" fill="none"/g)];
  assert.equal(lines.length, 1);
  assert.match(lines[0]![1]!, /^M215,84\.5 C.+ 541,12$/);
  assert.equal((lines[0]![1]!.match(/C/g) ?? []).length, 1);
  assert.match(html, /2026-09-03: 没有记录/);
  assert.match(html, /2026-09-04: 没有记录/);
});

test('missing days produce no bars and an entirely unknown trend stays empty', () => {
  const bars = renderToStaticMarkup(createElement(TrendChart, { days, mode: 'bar' }));
  assert.equal((bars.match(/fill="#38b6c2"/g) ?? []).length, 2);
  const empty = renderToStaticMarkup(createElement(TrendChart, { days: days.map(p => ({ ...p, value: null })), mode: 'area' }));
  assert.doesNotMatch(empty, /<path /);
  assert.match(empty, /暂无趋势数据/);
});
