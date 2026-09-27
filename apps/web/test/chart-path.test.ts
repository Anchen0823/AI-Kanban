import test from 'node:test';
import assert from 'node:assert/strict';
import { smoothPath } from '../src/chart-path.js';

test('smooth curves preserve observations and cannot invent peaks or negative usage', () => {
  const values = [0, 3, 900, 2, 2, 0, 80, 81, 700, 0];
  const path = smoothPath(values.map((y, x) => ({x, y})));
  const segments = [...path.matchAll(/C([^C]+)/g)];
  assert.equal(segments.length, values.length - 1);
  segments.forEach((match, i) => {
    const [x1, y1, x2, y2, x3, y3] = match[1]!.trim().split(/[ ,]+/).map(Number) as [number,number,number,number,number,number];
    assert.equal(x3, i + 1);
    assert.equal(y3, values[i + 1]);
    const start = values[i]!;
    for (let step = 0; step <= 100; step++) {
      const t = step / 100, u = 1 - t;
      const y = u**3 * start + 3*u*u*t*y1 + 3*u*t*t*y2 + t**3*y3;
      assert.ok(y >= Math.min(start,y3) - 1e-9 && y <= Math.max(start,y3) + 1e-9);
    }
    assert.ok(x1 > i && x2 < x3);
  });
});

test('empty and isolated observations remain unconnected', () => {
  assert.equal(smoothPath([]), '');
  assert.equal(smoothPath([{x:5,y:42}]), 'M5,42');
});
