import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CodexProbeResult } from '../src/collectors/codex-usage.js';
import { getCodexDetection, runCodexDetection } from '../src/services/codex-detection.js';
import { createHarness } from './helpers.js';

function successProbe(): CodexProbeResult {
  return {
    report: {
      status: 'verified',
      clientVersion: 'codex-cli fixture 1.0',
      transport: 'fixture',
      authMode: 'fixture',
      evidence: 'fixture only',
      detail: {},
      notes: 'fixture only',
    },
    quotaSnapshots: [
      {
        bucketId: 'codex:primary',
        bucketLabel: 'Codex · 主窗口（5 小时）',
        scope: null,
        windowKind: 'custom',
        windowSeconds: 18_000,
        usedRatio: 0.42,
        remainingRatio: 0.58,
        resetAt: '2026-09-20T00:00:00.000Z',
        sourceRef: 'fixture',
      },
    ],
    warnings: [],
  };
}

function failedProbe(message = '未登录 user@example.com'): CodexProbeResult {
  return {
    report: {
      status: 'unknown',
      clientVersion: 'codex-cli fixture 1.0',
      transport: 'fixture',
      authMode: 'fixture',
      evidence: 'fixture only',
      detail: { reason_code: 'rate_limits_call_failed' },
      notes: message,
    },
    quotaSnapshots: [],
    warnings: [],
  };
}

test('Codex 检测默认未配置；路由只允许本机用户会话', async () => {
  const h = await createHarness();
  try {
    assert.deepEqual(getCodexDetection(h.app.ctx).status, 'not_configured');
    const current = await h.request<{ status: string; windows: unknown[] }>('GET', '/api/detection/codex');
    assert.equal(current.status, 200);
    assert.equal(current.headers['cache-control'], 'no-store');
    assert.equal(current.body.status, 'not_configured');
    assert.deepEqual(current.body.windows, []);
    assert.equal((await h.anonymous('POST', '/api/detection/codex')).status, 401);

    const demoRead = await h.request('GET', '/api/detection/codex?workspace=demo');
    const demoRefresh = await h.request('POST', '/api/detection/codex?workspace=demo');
    assert.equal(demoRead.status, 403, '示例工作区不得读取真实的本机额度快照');
    assert.equal(demoRefresh.status, 403, '示例工作区不得启动本机额度检测');
    assert.equal(demoRead.headers['cache-control'], 'no-store');
    assert.equal(demoRefresh.headers['cache-control'], 'no-store');
  } finally {
    h.close();
  }
});

test('检测成功保存无凭据窗口；失败保留最后一次成功窗口并脱敏错误', async () => {
  const h = await createHarness();
  try {
    const ok = await runCodexDetection(h.app.ctx, { probe: async () => successProbe() });
    assert.equal(ok.status, 'ok');
    assert.equal(ok.clientVersion, 'codex-cli fixture 1.0');
    assert.deepEqual(ok.windows, [
      {
        label: 'Codex · 主窗口（5 小时）',
        usedPercent: 42,
        remainingPercent: 58,
        resetAt: '2026-09-20T00:00:00.000Z',
        windowSeconds: 18_000,
      },
    ]);
    assert.ok(ok.checkedAt);
    assert.equal(ok.lastSuccessAt, ok.checkedAt);

    const failed = await runCodexDetection(h.app.ctx, { probe: async () => failedProbe('未登录 user@example.com；Bearer fixture-secret') });
    assert.equal(failed.status, 'error');
    assert.equal(failed.lastSuccessAt, ok.lastSuccessAt);
    assert.deepEqual(failed.windows, ok.windows, '失败不能把上次的窗口伪造成 100% 或清空');
    assert.doesNotMatch(failed.message, /user@example\.com/);
    assert.doesNotMatch(failed.message, /fixture-secret/);
    assert.match(failed.message, /已隐藏邮箱/);
    assert.match(failed.message, /Bearer \[已隐藏\]/);
    assert.deepEqual(getCodexDetection(h.app.ctx), failed, 'GET 读取的是无凭据的最近结果');
  } finally {
    h.close();
  }
});

test('并发刷新只启动一个 Codex 探测进程', async () => {
  const h = await createHarness();
  try {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const probe = async () => {
      calls += 1;
      await gate;
      return successProbe();
    };

    const first = runCodexDetection(h.app.ctx, { probe });
    const second = runCodexDetection(h.app.ctx, { probe });
    assert.equal(first, second);
    assert.equal(calls, 1);
    release?.();
    assert.equal((await first).status, 'ok');
    assert.equal(calls, 1);
  } finally {
    h.close();
  }
});
