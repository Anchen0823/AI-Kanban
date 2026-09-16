import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyWindow, maskEmail, probeCodex, snapshotsToDrafts } from '../src/collectors/codex-usage.js';
import { extractMethodList } from '../src/collectors/codex-app-server.js';
import { storeProbeQuotaSnapshots } from '../src/services/integration-probe.js';
import { createHarness, makeAccount } from './helpers.js';

/**
 * Codex 只读探测的三态判定（M1）。
 *
 * 最重要的一条断言不是「能拿到数据」，而是**遇到问题时不要下错结论**：
 * 把网络不可达报成「该版本不支持」，用户就再也不会去试；反过来把
 * 「方法不存在」报成「环境问题」，用户会一直重启服务而问题永远不解决。
 *
 * 用假的 app-server 可执行文件（真子进程、真管道）覆盖四种分支。
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE = join(FIXTURES, 'fake-codex-app-server.mjs');

/** 用受控的可执行文件替换 codex，但保留真实的子进程与 stdio 管道。 */
function fakeSpawn(mode: string): typeof spawn {
  return ((_command: string, args: readonly string[], options: Record<string, unknown>) =>
    spawn(process.execPath, [FAKE, ...args], {
      ...options,
      env: { ...(options.env as Record<string, string>), FAKE_CODEX_MODE: mode },
      shell: false,
    })) as unknown as typeof spawn;
}

function probe(mode: string) {
  return probeCodex({ command: 'codex', spawnImpl: fakeSpawn(mode), timeoutMs: 8000 });
}

/* ------------------------------------------------------------------ */
/* 三态判定                                                            */
/* ------------------------------------------------------------------ */

test('拿到额度窗口 → verified，并把三个方法的实测结论写进证据', async () => {
  const result = await probe('ok');

  assert.equal(result.report.status, 'verified');
  assert.equal(result.report.clientVersion, 'codex-cli 0.130.0-fake');

  // 证据必须能复现：命令、版本、逐方法结论都要在
  assert.match(result.report.evidence, /codex-cli 0\.130\.0-fake/);
  assert.match(result.report.evidence, /account\/rateLimits\/read → 成功/);
  assert.match(result.report.evidence, /account\/usage\/read → 该版本不支持此方法/);
  assert.match(result.report.evidence, /thread\/tokenUsage\/updated → 存在但本次未收到/);

  // 设计稿 §3.2 提到的方法在 0.130.0 上不存在 —— 这条结论要有据可依
  const detail = result.report.detail as {
    supports_account_usage_read: boolean;
    supports_rate_limits_read: boolean;
    legal_method_count: number | null;
  };
  assert.equal(detail.supports_account_usage_read, false);
  assert.equal(detail.supports_rate_limits_read, true);
  assert.ok((detail.legal_method_count ?? 0) > 0, '要把该版本合法方法数记下来作为证据');
});

test('方法不在协议里 → unsupported（不是 unknown）', async () => {
  const result = await probe('no-rate-limits-method');
  assert.equal(result.report.status, 'unsupported');
  assert.match(result.report.evidence, /account\/rateLimits\/read → 该版本不支持此方法/);
  assert.match(result.report.notes, /手工录入/);
});

test('方法存在但这次调用失败 → unknown，且原因写明是环境/登录问题', async () => {
  // 这是本机实测的真实情形：chatgpt.com 不可达。
  // 报成 unsupported 会让人以为这个版本没有这个能力，从而永远不再试。
  const result = await probe('call-fails');
  assert.equal(result.report.status, 'unknown');
  const detail = result.report.detail as { reason_code: string; reason: string };
  assert.equal(detail.reason_code, 'rate_limits_call_failed');
  assert.match(detail.reason, /不是「该版本不支持」/);
  assert.match(result.report.evidence, /account\/rateLimits\/read → 调用失败/);
  assert.equal(result.quotaSnapshots.length, 0, '失败时不得编造快照');
});

test('调用成功但没有窗口 → unknown，不假装拿到了 0%', async () => {
  const result = await probe('empty-windows');
  assert.equal(result.report.status, 'unknown');
  assert.equal((result.report.detail as { reason_code: string }).reason_code, 'no_rate_limit_windows');
  assert.equal(result.quotaSnapshots.length, 0);
});

test('本机没有 codex → unknown（装一个就会改变结论，不能说「不支持」）', async () => {
  const result = await probeCodex({ command: 'aicc-definitely-not-installed' });
  assert.equal(result.report.status, 'unknown');
  assert.equal(result.report.clientVersion, null);
  const detail = result.report.detail as { reason_code: string };
  assert.equal(detail.reason_code, 'codex_not_installed');
  assert.match(result.report.notes, /手动导入与额度手工录入不受影响/);
});

test('探测期间的配置警告要浮出来，不能吞掉', async () => {
  const result = await probe('ok');
  assert.ok(
    result.warnings.some((w) => /configWarning/.test(w)),
    `配置警告会直接导致「MCP 挂不上」这类现象，必须出现在警告里。实际：${JSON.stringify(result.warnings)}`,
  );
});

/* ------------------------------------------------------------------ */
/* 隐私与映射                                                          */
/* ------------------------------------------------------------------ */

test('账号邮箱脱敏后才进证据，完整地址不落库', async () => {
  assert.equal(maskEmail('someone@example.com'), 'so***@example.com');
  assert.equal(maskEmail('a@b.c'), 'a***@b.c');
  assert.equal(maskEmail('没有at符号'), '***');

  const result = await probe('ok');
  const serialized = JSON.stringify(result.report);
  assert.doesNotMatch(serialized, /someone@example\.com/, '完整邮箱不该出现在报告里');
  assert.match(serialized, /so\*\*\*@example\.com/);
});

test('多桶视图优先，窗口类型不把 5 小时说成 hourly', async () => {
  const drafts = snapshotsToDrafts({
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 42, resetsAt: 1790000000, windowDurationMins: 300 },
        secondary: { usedPercent: 8, resetsAt: 1790500000, windowDurationMins: 10080 },
      },
      code_review: { limitId: 'code_review', limitName: 'Code Review', primary: { usedPercent: 100, windowDurationMins: 1440 } },
    },
  });

  assert.deepEqual(
    drafts.map((d) => d.bucketId),
    ['codex:primary', 'codex:secondary', 'code_review:primary'],
  );

  const primary = drafts[0] as (typeof drafts)[number];
  assert.equal(primary.windowKind, 'custom', '5 小时不是 hourly —— 标 custom 并带秒数才不误导');
  assert.equal(primary.windowSeconds, 300 * 60);
  assert.equal(primary.usedRatio, 0.42);
  assert.equal(primary.remainingRatio, 0.58);
  // 这一条曾经真的失败过：`1 - 0.42` 得到 0.5800000000000001。
  // 两个比例必须在同一套舍入下互补，否则界面上会出现「已用 42%、剩余 58.00000001%」。
  assert.equal(primary.usedRatio + primary.remainingRatio, 1);
  assert.equal(primary.resetAt, new Date(1790000000 * 1000).toISOString());

  assert.equal((drafts[1] as (typeof drafts)[number]).windowKind, 'weekly');
  assert.equal((drafts[2] as (typeof drafts)[number]).windowKind, 'daily');
  assert.match((drafts[0] as (typeof drafts)[number]).bucketLabel, /主窗口/);
});

test('窗口类型分类：只对恰好等于常见周期的给确定答案', () => {
  assert.equal(classifyWindow(60).kind, 'hourly');
  assert.equal(classifyWindow(1440).kind, 'daily');
  assert.equal(classifyWindow(10080).kind, 'weekly');
  assert.equal(classifyWindow(43200).kind, 'monthly');
  assert.equal(classifyWindow(300).kind, 'custom');
  assert.equal(classifyWindow(300).label, '5 小时');
  assert.equal(classifyWindow(90).label, '90 分钟');
  assert.equal(classifyWindow(null).kind, 'custom');
  assert.equal(classifyWindow(0).kind, 'custom');
});

test('从 RPC 错误里能抠出该版本的合法方法列表', () => {
  const methods = extractMethodList(
    'Invalid request: unknown variant `account/usage/read`, expected one of `initialize`, `thread/start`, `account/read`',
  );
  assert.deepEqual(methods, ['initialize', 'thread/start', 'account/read']);
  assert.deepEqual(extractMethodList('完全无关的错误信息'), []);
});

/* ------------------------------------------------------------------ */
/* 落库                                                                */
/* ------------------------------------------------------------------ */

test('探测到的快照按 official_api / provider_reported 落库', async () => {
  const h = await createHarness();
  try {
    const accountId = await makeAccount(h);
    const drafts = snapshotsToDrafts({
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 42, resetsAt: 1790000000, windowDurationMins: 300 },
        secondary: { usedPercent: 8, windowDurationMins: 10080 },
      },
    });

    const result = storeProbeQuotaSnapshots(h.app.ctx, accountId, drafts, '0.1.0-test');
    assert.equal(result.stored, 2);
    assert.deepEqual(result.warnings, []);

    const rows = h.app.db
      .prepare('SELECT bucket_id, used_ratio, collection_method, measurement_quality, adapter_version FROM quota_snapshot WHERE account_id = ? ORDER BY bucket_id')
      .all<{ bucket_id: string; used_ratio: number; collection_method: string; measurement_quality: string; adapter_version: string }>(accountId);

    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.collection_method, 'official_api');
    assert.equal(rows[0]?.measurement_quality, 'provider_reported');
    assert.equal(rows[0]?.adapter_version, '0.1.0-test');
    assert.equal(rows[0]?.used_ratio, 0.42);
  } finally {
    h.close();
  }
});

test('没有账户时拒绝落库并说明原因，不造一个「未指定」账户', async () => {
  const h = await createHarness();
  try {
    const drafts = snapshotsToDrafts({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 60 } } });
    const result = storeProbeQuotaSnapshots(h.app.ctx, null, drafts, '0.1.0-test');

    assert.equal(result.stored, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? '', /不会替你造一个「未指定」账户/);

    const count = h.app.db.prepare('SELECT COUNT(*) AS n FROM quota_snapshot').get<{ n: number }>()?.n ?? 0;
    assert.equal(count, 0);
  } finally {
    h.close();
  }
});

test('账户不存在时报 404，而不是静默丢弃', async () => {
  const h = await createHarness();
  try {
    const drafts = snapshotsToDrafts({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 60 } } });
    assert.throws(
      () => storeProbeQuotaSnapshots(h.app.ctx, 'acc_不存在', drafts, '0.1.0-test'),
      /计费账户不存在/,
    );
  } finally {
    h.close();
  }
});

test('没有快照时不需要账户，也不产生警告', async () => {
  const h = await createHarness();
  try {
    const result = storeProbeQuotaSnapshots(h.app.ctx, null, [], '0.1.0-test');
    assert.equal(result.stored, 0);
    assert.deepEqual(result.warnings, []);
  } finally {
    h.close();
  }
});
