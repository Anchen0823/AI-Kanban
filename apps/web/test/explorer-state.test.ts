import test from 'node:test';
import assert from 'node:assert/strict';
import { explorerFilter, explorerHref, explorerQuery, readExplorerLocation, recentUtcRange } from '../src/explorer-state.js';
test('hash navigation retains shared filters, details and paging without putting search text into the URL', () => {
  const href = explorerHref('sessions', { page: '2', model: 'model/a' }, 'session-id', '#workspaces?source=codex&from=2026-10-01');
  const location = readExplorerLocation(href);
  assert.equal(location.view, 'sessions'); assert.equal(location.id, 'session-id');
  const filter = explorerFilter(location.params, 'private search');
  assert.equal(filter.source, 'codex'); assert.equal(filter.page, 2); assert.equal(filter.q, 'private search');
  assert.equal(filter.model, 'model/a'); assert.ok(explorerQuery(filter).includes('q=private+search'));
  assert.ok(!href.includes('private'));
  assert.equal(readExplorerLocation('#unknown').view, 'overview');
  assert.equal(readExplorerLocation(explorerHref('sessions', { page: undefined }, undefined, href)).id, undefined);
});
test('UTC recent-date presets are inclusive and do not depend on host timezone', () => {
  assert.deepEqual(recentUtcRange(7, Date.parse('2026-10-03T23:55:00Z')), { from: '2026-09-27', to: '2026-10-03' });
  assert.deepEqual(recentUtcRange(0), {});
});
