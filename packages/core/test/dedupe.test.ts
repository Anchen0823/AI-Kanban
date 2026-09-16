import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, contentFingerprint, fileFingerprint, normalizeText } from '../src/ids.js';
import { classifyDuplicate, computeDedupeKeys, isCountedInTotals } from '../src/dedupe.js';

/** 幂等与去重。设计稿 §5.5，覆盖 U01 / U04 的规则层。 */

test('U01：同一文件连续导入两次，去重键完全相同', () => {
  const file = fileFingerprint('usage.csv', 'input_tokens,output_tokens\n100,20\n');
  const row = {
    accountId: 'acc_1',
    meterKind: 'tokens' as const,
    fileFingerprint: file,
    rowIndex: 1,
    model: 'gpt-x',
    occurredAt: '2026-09-01T00:00:00.000Z',
    inputTotal: 100,
    outputTotal: 20,
    totalReported: 120,
  };

  const first = computeDedupeKeys(row);
  const second = computeDedupeKeys({ ...row });
  assert.equal(first.dedupeKey, second.dedupeKey);
  assert.equal(first.identityKey, second.identityKey);

  const decision = classifyDuplicate(first, {
    byDedupeKey: { id: 'obs_1', dedupeKey: first.dedupeKey, identityKey: first.identityKey, fileFingerprint: file },
    byIdentityKey: { id: 'obs_1', dedupeKey: first.dedupeKey, identityKey: first.identityKey, fileFingerprint: file },
  });
  assert.equal(decision.kind, 'replay');
});

test('内容指纹与键序无关 —— 否则同一行换个字段顺序就会被当成新记录', () => {
  const a = contentFingerprint({ model: 'x', input: 1, output: 2 });
  const b = contentFingerprint({ output: 2, model: 'x', input: 1 });
  assert.equal(a, b);

  const fileA = fileFingerprint('f.csv', 'a,b\n1,2\n');
  const fileB = fileFingerprint('f.csv', 'a,b\n1,2\n');
  assert.equal(fileA, fileB);

  const fileC = fileFingerprint('f.csv', 'a,b\n1,3\n');
  assert.notEqual(fileA, fileC);

  const fileD = fileFingerprint('g.csv', 'a,b\n1,2\n');
  assert.notEqual(fileA, fileD, '文件名不同应得到不同指纹');
});

test('手动录入（无文件）用行号构造去重键，且不与文件导入互相顶掉', () => {
  const manual = computeDedupeKeys({ accountId: 'acc_1', meterKind: 'tokens', rowIndex: 3, inputTotal: 10, outputTotal: 0 });
  const fromFile = computeDedupeKeys({
    accountId: 'acc_1',
    meterKind: 'tokens',
    fileFingerprint: fileFingerprint('f.csv', 'x'),
    rowIndex: 3,
    inputTotal: 10,
    outputTotal: 0,
  });
  assert.notEqual(manual.dedupeKey, fromFile.dedupeKey);
  // 但内容相同，所以身份键一致 —— 会在导入时被标为待确认
  assert.equal(manual.identityKey, fromFile.identityKey);
});

test('U04：同一请求 ID 出现在不同来源 → 只计一次，其余作为证据', () => {
  const base = {
    accountId: 'acc_1',
    providerRequestId: 'req_abc',
    meterKind: 'tokens' as const,
    totalReported: 120,
  };
  const fromGateway = computeDedupeKeys({ ...base, fileFingerprint: fileFingerprint('gw.csv', 'gw'), rowIndex: 1 });
  const fromLog = computeDedupeKeys({ ...base, fileFingerprint: fileFingerprint('log.csv', 'log'), rowIndex: 9 });

  assert.equal(fromGateway.identityKey, fromLog.identityKey, '不同来源必须得到同一身份键');
  assert.equal(fromGateway.identityConfidence, 'stable_id');
  assert.notEqual(fromGateway.dedupeKey, fromLog.dedupeKey, '批次内去重键仍然各自独立');

  const decision = classifyDuplicate(fromLog, {
    byIdentityKey: {
      id: 'obs_gateway',
      dedupeKey: fromGateway.dedupeKey,
      identityKey: fromGateway.identityKey,
      fileFingerprint: fileFingerprint('gw.csv', 'gw'),
    },
  });
  assert.equal(decision.kind, 'evidence');
  if (decision.kind !== 'evidence') throw new Error('不可达');
  assert.equal(decision.duplicateOf, 'obs_gateway');
});

test('没有稳定 ID 时跨文件命中标为待确认，不静默合并也不静默丢弃', () => {
  const row = {
    accountId: 'acc_1',
    meterKind: 'tokens' as const,
    model: 'm',
    occurredAt: '2026-09-01T00:00:00.000Z',
    totalReported: 42,
  };
  const fileOne = fileFingerprint('one.csv', 'a');
  const fileTwo = fileFingerprint('two.csv', 'b');

  const incoming = computeDedupeKeys({ ...row, fileFingerprint: fileTwo, rowIndex: 0 });
  assert.equal(incoming.identityConfidence, 'content_fingerprint');

  const decision = classifyDuplicate(incoming, {
    byIdentityKey: { id: 'obs_first', dedupeKey: 'file|x|0', identityKey: incoming.identityKey, fileFingerprint: fileOne },
  });
  assert.equal(decision.kind, 'suspect');
  if (decision.kind !== 'suspect') throw new Error('不可达');
  assert.match(decision.reason, /无法确认是否为同一请求/);
});

test('完全没有信号时不构造可互相顶掉的身份键', () => {
  const keys = computeDedupeKeys({ accountId: null, meterKind: 'tokens', fileFingerprint: 'f', rowIndex: 0 });
  assert.equal(keys.identityConfidence, 'none');
  assert.match(keys.identityKey, /^anon/);
});

test('INV-04：只有 isPrimary 且未被标记为待确认的记录计入统计', () => {
  assert.equal(isCountedInTotals({ isPrimary: true, duplicateStatus: 'none' }), true);
  assert.equal(isCountedInTotals({ isPrimary: true, duplicateStatus: 'resolved_unique' }), true);
  assert.equal(isCountedInTotals({ isPrimary: false, duplicateStatus: 'none' }), false);
  assert.equal(isCountedInTotals({ isPrimary: true, duplicateStatus: 'suspect' }), false);
  assert.equal(isCountedInTotals({ isPrimary: true, duplicateStatus: 'merged_evidence' }), false);
});

test('canonicalJson 稳定：嵌套对象与数组处理一致', () => {
  const v = { b: [1, { z: 1, a: 2 }], a: null, c: undefined };
  assert.equal(canonicalJson(v), '{"a":null,"b":[1,{"a":2,"z":1}]}');
  assert.equal(canonicalJson(undefined), 'null');
  assert.equal(canonicalJson(Number.NaN), 'null');
  assert.equal(canonicalJson(10n), '"10"');
});

test('normalizeText 统一换行与行尾空白', () => {
  assert.equal(normalizeText('a  \r\nb\r\n\r\n'), 'a\nb');
  assert.equal(normalizeText('  中文  \n'), '中文');
});
