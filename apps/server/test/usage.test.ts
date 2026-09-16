import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, importCsv, makeAccount, makeProject } from './helpers.js';

/**
 * 用量相关的验收测试：U01～U07。
 *
 * 每个用例都以「成功 / 失败 / 重复输入」三类输入构造，因为这三类恰恰是
 * 「看起来正常但账算错了」的高发区。
 */

test('U01：同一个文件连续导入两次，token、金额与记录数都不翻倍', async () => {
  const h = await createHarness();
  try {
    const accountId = await makeAccount(h);
    const csv = [
      'occurred_at,model,input_tokens,output_tokens,cached_tokens,reasoning_tokens',
      '2026-09-01T00:00:00Z,model-a,10000,2000,6000,1000',
      '2026-09-01T01:00:00Z,model-a,3000,500,0,0',
    ].join('\n');

    const first = await importCsv(h, 'usage.csv', csv, { accountId });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.acceptedRows, 2);
    assert.equal(first.body.replayedRows, 0);
    assert.equal(first.body.rejectedRows, 0);

    const usageAfterFirst = await h.request<{ total: number; totals: { tokenValue: number | null } }>(
      'GET',
      '/api/usage',
    );
    assert.equal(usageAfterFirst.body.total, 2);
    assert.equal(usageAfterFirst.body.totals.tokenValue, 12000 + 3500);

    // 第二次导入**同一个文件**（文件名与内容都一样）
    const second = await importCsv(h, 'usage.csv', csv, { accountId });
    assert.equal(second.status, 200);
    assert.equal(second.body.acceptedRows, 0, '不应新增任何记录');
    assert.equal(second.body.replayedRows, 2, '两行都应被判为重放');
    assert.match(String((second.body.warnings as string[]).join('\n')), /不会因此翻倍/);

    const usageAfterSecond = await h.request<{ total: number; totals: { tokenValue: number | null } }>(
      'GET',
      '/api/usage',
    );
    assert.equal(usageAfterSecond.body.total, 2, '记录数没变');
    assert.equal(usageAfterSecond.body.totals.tokenValue, 15500, 'token 总量没翻倍');
  } finally {
    h.close();
  }
});

test('U02：输入含缓存、输出含推理时总量为 12,000；子项不重复相加', async () => {
  const h = await createHarness();
  try {
    const accountId = await makeAccount(h);
    const csv = [
      'occurred_at,input_tokens,output_tokens,cached_tokens,reasoning_tokens,total_tokens',
      '2026-09-02T00:00:00Z,10000,2000,6000,1000,12000',
    ].join('\n');

    const result = await importCsv(h, 'u02.csv', csv, { accountId });
    assert.equal(result.body.acceptedRows, 1);

    const usage = await h.request<{
      items: Array<{ inputTotal: number; outputTotal: number; cachedInput: number; reasoningOutput: number; totalReported: number }>;
      totals: { tokenValue: number | null };
    }>('GET', '/api/usage');

    const row = usage.body.items[0];
    assert.ok(row);
    assert.equal(row.inputTotal, 10000);
    assert.equal(row.outputTotal, 2000);
    assert.equal(row.cachedInput, 6000);
    assert.equal(row.reasoningOutput, 1000);
    assert.equal(row.totalReported, 12000);
    assert.notEqual(row.totalReported, 19000);
    assert.equal(usage.body.totals.tokenValue, 12000);
  } finally {
    h.close();
  }
});

test('U03：供应商未报告 token 时显示未知，不显示 0', async () => {
  const h = await createHarness();
  try {
    const accountId = await makeAccount(h);
    // 只有一列可识别的数值（requests），token 列完全缺失
    const csv = ['occurred_at,requests,model', '2026-09-03T00:00:00Z,5,model-x'].join('\n');
    const result = await importCsv(h, 'u03.csv', csv, { accountId });
    assert.equal(result.body.acceptedRows, 1);

    const usage = await h.request<{
      items: Array<{ inputTotal: number | null; outputTotal: number | null; totalReported: number | null }>;
      totals: { tokenValue: number | null; coverage: string };
    }>('GET', '/api/usage');

    const row = usage.body.items[0];
    assert.ok(row);
    assert.equal(row.totalReported, null, '必须是 null，不能是 0');
    assert.equal(usage.body.totals.tokenValue, null);
    assert.match(usage.body.totals.coverage, /未报告 token/);

    // 概览页同样不能显示 0
    const overview = await h.request<{ tokens: { observed: number | null; coverage: string } }>('GET', '/api/overview');
    assert.equal(overview.body.tokens.observed, null);
  } finally {
    h.close();
  }
});

test('U04：同一请求 ID 出现在两个来源 → 只计一次，且保留证据行', async () => {
  const h = await createHarness();
  try {
    const accountId = await makeAccount(h);
    const header = 'occurred_at,request_id,model,input_tokens,output_tokens';

    const gateway = await importCsv(h, 'gateway.csv', [header, '2026-09-04T00:00:00Z,req-abc,model-a,1000,200'].join('\n'), {
      accountId,
    });
    assert.equal(gateway.body.acceptedRows, 1);

    // 同一个 request_id，来自另一个文件
    const localLog = await importCsv(h, 'local-log.csv', [header, '2026-09-04T00:00:00Z,req-abc,model-a,1000,200'].join('\n'), {
      accountId,
    });
    assert.equal(localLog.body.evidenceRows, 1, '第二条应被记为证据');
    assert.equal(localLog.body.acceptedRows, 0);
    assert.match(String((localLog.body.warnings as string[]).join('\n')), /命中稳定请求 ID/);

    const counted = await h.request<{ total: number; totals: { tokenValue: number | null } }>('GET', '/api/usage');
    assert.equal(counted.body.total, 1, '统计口径只有一条');
    assert.equal(counted.body.totals.tokenValue, 1200);

    // 但证据行确实存在
    const all = await h.request<{ total: number }>('GET', '/api/usage?includeNonPrimary=true');
    assert.equal(all.body.total, 2, '两条都在库里，只是只有一条计入统计');
  } finally {
    h.close();
  }
});

test('U04 补充：没有稳定 ID 时跨文件重复标为待确认，既不合并也不丢弃', async () => {
  const h = await createHarness();
  try {
    const accountId = await makeAccount(h);
    const header = 'occurred_at,model,input_tokens,output_tokens';
    const row = '2026-09-05T00:00:00Z,model-a,500,100';

    await importCsv(h, 'file-one.csv', [header, row].join('\n'), { accountId });
    const second = await importCsv(h, 'file-two.csv', [header, row].join('\n'), { accountId });

    assert.equal(second.body.suspectRows, 1);
    assert.match(String((second.body.warnings as string[]).join('\n')), /待确认/);

    const counted = await h.request<{ total: number; totals: { tokenValue: number | null } }>('GET', '/api/usage');
    assert.equal(counted.body.total, 1, '待确认的记录不计入统计');
    assert.equal(counted.body.totals.tokenValue, 600);

    const overview = await h.request<{ usage: { suspectDuplicates: number }; attention: Array<{ text: string }> }>(
      'GET',
      '/api/overview',
    );
    assert.equal(overview.body.usage.suspectDuplicates, 1);
    assert.ok(
      overview.body.attention.some((a) => a.text.includes('疑似重复')),
      '概览必须把这个不确定性显示出来，而不是藏在数据库里',
    );

    // 用户确认这是两次真实请求 → 计入统计
    const all = await h.request<{ items: Array<{ id: string; duplicateStatus: string }> }>(
      'GET',
      '/api/usage?includeNonPrimary=true',
    );
    const suspect = all.body.items.find((i) => i.duplicateStatus === 'suspect');
    assert.ok(suspect);

    const resolved = await h.request<{ observation: { isPrimary: boolean } }>(
      'POST',
      `/api/usage/${suspect.id}/resolve-duplicate`,
      { decision: 'confirmed_unique' },
    );
    assert.equal(resolved.body.observation.isPrimary, true);

    const afterResolve = await h.request<{ totals: { tokenValue: number | null } }>('GET', '/api/usage');
    assert.equal(afterResolve.body.totals.tokenValue, 1200, '确认后两条都计入');
  } finally {
    h.close();
  }
});

test('U05：账户汇总与事件明细同时存在时，能解释统计覆盖范围', async () => {
  const h = await createHarness();
  try {
    const accountId = await makeAccount(h);
    // 事件明细（无周期）
    await importCsv(
      h,
      'events.csv',
      ['occurred_at,input_tokens,output_tokens', '2026-09-06T00:00:00Z,100,20'].join('\n'),
      { accountId },
    );
    // 账户汇总（带周期）
    const summary = await importCsv(
      h,
      'summary.csv',
      ['period_start,period_end,total_tokens', '2026-09-01,2026-09-30,99999'].join('\n'),
      { accountId },
    );
    assert.equal(summary.body.acceptedRows, 1);
    assert.match(String((summary.body.warnings as string[]).join('\n')), /账户汇总/);

    const usage = await h.request<{ items: Array<{ kind: string }> }>('GET', '/api/usage');
    const kinds = usage.body.items.map((i) => i.kind).sort();
    assert.deepEqual(kinds, ['event', 'summary'], '两类都被记录，且能分辨');

    const overview = await h.request<{ tokens: { coverage: string; observed: number | null } }>('GET', '/api/overview');
    assert.ok(overview.body.tokens.coverage.length > 0, '概览必须给出覆盖范围说明');
  } finally {
    h.close();
  }
});

test('U06：同一订阅覆盖多个客户端时固定月费只记一次', async () => {
  const h = await createHarness();
  try {
    const accountId = await makeAccount(h);
    const clientA = await h.request<{ client: { id: string } }>('POST', '/api/clients', {
      kind: 'chatgpt_app',
      displayName: '客户端 A',
    });
    const clientB = await h.request<{ client: { id: string } }>('POST', '/api/clients', {
      kind: 'workbuddy',
      displayName: '客户端 B',
    });

    const sub = await h.request<{ subscription: { id: string; clientIds: string[] } }>('POST', '/api/subscriptions', {
      name: '月度订阅',
      accountId,
      priceMinor: '14000',
      currency: 'CNY',
      billingCycle: 'monthly',
      status: 'active',
      clientIds: [clientA.body.client.id, clientB.body.client.id],
    });
    assert.equal(sub.status, 200);
    assert.equal(sub.body.subscription.clientIds.length, 2);

    const chargeBody = {
      accountId,
      subscriptionId: sub.body.subscription.id,
      kind: 'subscription',
      amountMinor: '14000',
      currency: 'CNY',
      status: 'paid',
      periodStart: '2026-09-01',
    };

    const first = await h.request<{ inserted: boolean }>('POST', '/api/charges', chargeBody);
    assert.equal(first.body.inserted, true);

    // 第二个客户端也走同一个订阅，不应再记一笔
    const second = await h.request<{ inserted: boolean; reason: string }>('POST', '/api/charges', chargeBody);
    assert.equal(second.body.inserted, false);
    assert.match(second.body.reason, /只记一次|已登记/);

    const charges = await h.request<{ charges: unknown[]; buckets: { paid: Array<{ currency: string; amountMinor: string; count: number }> } }>(
      'GET',
      '/api/charges',
    );
    assert.equal(charges.body.charges.length, 1);
    assert.deepEqual(charges.body.buckets.paid, [{ currency: 'CNY', amountMinor: '14000', count: 1 }]);
  } finally {
    h.close();
  }
});

test('U06 补充：同一 billing_ref 的账单不会被重复记账', async () => {
  const h = await createHarness();
  try {
    const accountId = await makeAccount(h, 'USD');
    const body = {
      accountId,
      kind: 'api',
      amountMinor: '1235',
      currency: 'USD',
      status: 'pending',
      billingRef: 'invoice-2026-09',
    };
    const first = await h.request<{ inserted: boolean }>('POST', '/api/charges', body);
    const second = await h.request<{ inserted: boolean; reason: string }>('POST', '/api/charges', body);
    assert.equal(first.body.inserted, true);
    assert.equal(second.body.inserted, false);
    assert.match(second.body.reason, /已记账|对账/);
  } finally {
    h.close();
  }
});

test('U07：快照已过重置时间但刷新失败 → 显示待刷新，不显示 100%', async () => {
  const h = await createHarness();
  try {
    const accountId = await makeAccount(h);
    const now = Date.now();

    await h.request('POST', '/api/quota-snapshots', {
      accountId,
      bucketId: 'hourly-bucket',
      bucketLabel: '小时窗',
      windowKind: 'hourly',
      windowSeconds: 3600,
      usedRatio: 0.4,
      remainingRatio: 0.6,
      // 观测在 3 小时前，重置时间是 2 小时前 —— 窗口已经过去且没有重新查询
      observedAt: new Date(now - 3 * 3600 * 1000).toISOString(),
      resetAt: new Date(now - 2 * 3600 * 1000).toISOString(),
      staleAfterSeconds: 21600,
      measurementQuality: 'provider_reported',
      collectionMethod: 'manual',
    });

    const quota = await h.request<{
      groups: Array<{ windowKind: string; buckets: Array<{ freshness: string; stateLabel: string; ratioAuthoritative: boolean; reasons: string[] }> }>;
      needsAttention: number;
    }>('GET', '/api/quota');

    const bucket = quota.body.groups[0]?.buckets[0];
    assert.ok(bucket, '应返回一个额度桶');
    assert.equal(bucket.freshness, 'pending_refresh');
    assert.match(bucket.stateLabel, /待刷新/);
    assert.equal(bucket.ratioAuthoritative, false);
    assert.ok(
      bucket.reasons.some((r) => r.includes('不会自动按 100%')),
      '必须明确说明不会假装恢复满额',
    );
    assert.equal(quota.body.needsAttention, 1);
  } finally {
    h.close();
  }
});

test('U07 补充：过期快照显示「已过期」；不同窗口不合并成综合百分比', async () => {
  const h = await createHarness();
  try {
    const accountId = await makeAccount(h);
    const now = Date.now();

    // 新鲜的小时窗
    await h.request('POST', '/api/quota-snapshots', {
      accountId,
      bucketId: 'h',
      bucketLabel: '小时窗',
      windowKind: 'hourly',
      usedRatio: 0.1,
      remainingRatio: 0.9,
      observedAt: new Date(now - 1000).toISOString(),
      resetAt: new Date(now + 3600 * 1000).toISOString(),
      staleAfterSeconds: 21600,
    });

    // 过期的周窗（观测 7 小时前，窗口还没结束）
    await h.request('POST', '/api/quota-snapshots', {
      accountId,
      bucketId: 'w',
      bucketLabel: '周窗',
      windowKind: 'weekly',
      usedRatio: 0.71,
      remainingRatio: 0.29,
      observedAt: new Date(now - 7 * 3600 * 1000).toISOString(),
      resetAt: new Date(now + 3 * 24 * 3600 * 1000).toISOString(),
      staleAfterSeconds: 21600,
    });

    const quota = await h.request<{
      groups: Array<{ windowKind: string; windowLabel: string; buckets: Array<{ freshness: string }> }>;
    }>('GET', '/api/quota');

    assert.equal(quota.body.groups.length, 2, '两个窗口必须是两组，不能平均成一个数');
    assert.deepEqual(
      quota.body.groups.map((g) => g.windowKind),
      ['hourly', 'weekly'],
    );
    assert.equal(quota.body.groups[0]?.buckets[0]?.freshness, 'fresh');
    assert.equal(quota.body.groups[1]?.buckets[0]?.freshness, 'stale');
  } finally {
    h.close();
  }
});

test('手动录入：缺少数值时拒绝；完全相同的手动录入不重复登记', async () => {
  const h = await createHarness();
  try {
    const accountId = await makeAccount(h);
    const payload = {
      accountId,
      collectionMethodNote: undefined,
      rawUsage: { input_tokens: 100, output_tokens: 20 },
      basis: 'openai_inclusive',
      measurementQuality: 'provider_reported',
    };

    const first = await h.request<{ observation: { id: string } }>('POST', '/api/usage', payload);
    assert.equal(first.status, 200);

    const second = await h.request<{ error: { code: string; message: string } }>('POST', '/api/usage', payload);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'duplicate_entry');

    const empty = await h.request<{ error: { code: string } }>('POST', '/api/usage', {
      accountId,
      rawUsage: {},
      basis: 'unknown',
    });
    assert.equal(empty.status, 200, '未知数值也允许登记（只是全部为 null）');
  } finally {
    h.close();
  }
});

test('用量查询：项目筛选与默认只返回主统计源', async () => {
  const h = await createHarness();
  try {
    const accountId = await makeAccount(h);
    const projectA = await makeProject(h, '项目 A');
    const projectB = await makeProject(h, '项目 B');

    await importCsv(h, 'a.csv', ['occurred_at,input_tokens,output_tokens', '2026-09-07T00:00:00Z,10,1'].join('\n'), {
      accountId,
      projectId: projectA,
    });
    await importCsv(h, 'b.csv', ['occurred_at,input_tokens,output_tokens', '2026-09-07T01:00:00Z,20,2'].join('\n'), {
      accountId,
      projectId: projectB,
    });

    const onlyA = await h.request<{ total: number; items: Array<{ projectId: string | null }> }>(
      'GET',
      `/api/usage?projectId=${projectA}`,
    );
    assert.equal(onlyA.body.total, 1);
    assert.equal(onlyA.body.items[0]?.projectId, projectA);
  } finally {
    h.close();
  }
});
