import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetFor,
  buildContextPackage,
  CONTEXT_DISCLAIMER,
  estimateTokens,
  renderContextJson,
  renderContextMarkdown,
  selectContextItems,
  type ContextCandidate,
} from '../src/context.js';

/** 上下文包构建。设计稿 §6.5 / §4.3 / §11.3，不变量 INV-13。 */

function item(overrides: Partial<ContextCandidate> & { memoryId: string }): ContextCandidate {
  return {
    version: 1,
    title: `记忆 ${overrides.memoryId}`,
    content: '正文内容',
    scope: 'project',
    projectId: 'prj_a',
    kind: 'decision',
    sensitivity: 'normal',
    pinned: false,
    updatedAt: '2026-09-01T00:00:00.000Z',
    relevance: 1,
    ...overrides,
  };
}

test('INV-13：权限过滤先于检索 —— 项目 B 的记忆根本不进入候选集', () => {
  const candidates = [
    item({ memoryId: 'mem_a1', projectId: 'prj_a' }),
    item({ memoryId: 'mem_b1', projectId: 'prj_b', title: '项目 B 的机密决策', content: '不应出现在 A 的上下文包里' }),
  ];

  const result = selectContextItems(candidates, {
    allowedProjectIds: ['prj_a'],
    projectId: 'prj_a',
    budgetTokens: 5000,
  });

  assert.deepEqual(
    result.selected.map((i) => i.memoryId),
    ['mem_a1'],
  );
  assert.equal(result.excludedByPolicy, 1);
  const md = renderContextMarkdown(
    buildContextPackage({
      packageId: 'ctx_1',
      projectId: 'prj_a',
      projectTitle: '项目 A',
      budgetKind: 'short',
      selection: result,
      generatedAt: '2026-09-16T00:00:00.000Z',
    }),
  );
  assert.ok(!md.includes('项目 B 的机密决策'), '被权限排除的内容绝不能出现在产物里');
  assert.ok(!md.includes('不应出现在 A 的上下文包里'));
});

test('默认不纳入 global 记忆 —— 不把整份个人画像塞给每个 agent', () => {
  const candidates = [
    item({ memoryId: 'mem_g', scope: 'global', projectId: null, title: '全局偏好' }),
    item({ memoryId: 'mem_p', scope: 'project', projectId: 'prj_a' }),
  ];

  const without = selectContextItems(candidates, { allowedProjectIds: ['prj_a'], projectId: 'prj_a', budgetTokens: 5000 });
  assert.deepEqual(without.selected.map((i) => i.memoryId), ['mem_p']);
  assert.equal(without.excludedByPolicy, 1);

  const withGlobal = selectContextItems(candidates, {
    allowedProjectIds: ['prj_a'],
    projectId: 'prj_a',
    budgetTokens: 5000,
    includeGlobalMemory: true,
  });
  assert.deepEqual(
    withGlobal.selected.map((i) => i.memoryId).sort(),
    ['mem_g', 'mem_p'],
  );
});

test('敏感等级超过上限的条目被排除，且不暴露内容', () => {
  const candidates = [
    item({ memoryId: 'mem_n', sensitivity: 'normal' }),
    item({ memoryId: 'mem_r', sensitivity: 'restricted', content: '凭据类内容' }),
  ];
  const result = selectContextItems(candidates, { allowedProjectIds: null, projectId: 'prj_a', budgetTokens: 5000 });
  assert.deepEqual(result.selected.map((i) => i.memoryId), ['mem_n']);
  assert.equal(result.excludedByPolicy, 1);
});

test('固定项超预算 → 提示用户取舍，绝不静默截断最重要约束', () => {
  const candidates = [
    item({ memoryId: 'mem_p1', pinned: true, content: '必须遵守的约束：'.concat('约束内容。'.repeat(400)) }),
    item({ memoryId: 'mem_p2', pinned: true, content: '另一条必须遵守的约束：'.concat('内容。'.repeat(400)) }),
  ];

  const result = selectContextItems(candidates, { allowedProjectIds: null, projectId: 'prj_a', budgetTokens: 200 });

  assert.equal(result.requiresUserChoice, true);
  assert.equal(result.selected.length, 2, '固定项保留，不能自动删掉');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] as string, /不会自动删除固定项/);
});

test('预算内按相关性填充，被挤掉的条目仍然被报告出来', () => {
  const candidates = [
    item({ memoryId: 'mem_high', relevance: 10, content: '高相关。'.repeat(20) }),
    item({ memoryId: 'mem_low', relevance: 1, content: '低相关。'.repeat(400) }),
  ];
  const result = selectContextItems(candidates, { allowedProjectIds: null, projectId: 'prj_a', budgetTokens: 200 });

  assert.deepEqual(result.selected.map((i) => i.memoryId), ['mem_high']);
  assert.deepEqual(result.dropped.map((i) => i.memoryId), ['mem_low']);
  assert.equal(result.requiresUserChoice, false);
  assert.match(result.warnings.join('\n'), /1 条记忆因预算未纳入/);
});

test('budgetFor：短版/标准版默认值与自定义预算校验', () => {
  assert.equal(budgetFor('short'), 1000);
  assert.equal(budgetFor('standard'), 2500);
  assert.equal(budgetFor('custom', 777), 777);
  assert.throws(() => budgetFor('custom'), /自定义预算必须是正数/);
  assert.throws(() => budgetFor('custom', 0), /自定义预算必须是正数/);
  assert.throws(() => budgetFor('custom', -5), /自定义预算必须是正数/);
});

test('token 计数标注为估算，并给出可核对的清单', () => {
  const selection = selectContextItems([item({ memoryId: 'mem_1', kind: 'decision' })], {
    allowedProjectIds: null,
    projectId: 'prj_a',
    budgetTokens: 1000,
  });
  const pkg = buildContextPackage({
    packageId: 'ctx_2',
    projectId: 'prj_a',
    projectTitle: '项目 A',
    task: '把项目 A 的当前决策交接给另一个客户端',
    budgetKind: 'short',
    selection,
    generatedAt: '2026-09-16T00:00:00.000Z',
  });

  assert.equal(pkg.manifest.tokenCountKind, 'estimated', '没有绑定 tokenizer 时不允许声称精确');
  assert.equal(pkg.manifest.items.length, 1);
  assert.equal(pkg.manifest.items[0]?.memoryId, 'mem_1');
  assert.equal(pkg.manifest.items[0]?.version, 1);
  assert.match(pkg.manifest.disclaimer, /不能证明目标模型已阅读/);

  const md = renderContextMarkdown(pkg);
  assert.ok(md.includes('## 本次目标'));
  assert.ok(md.includes('## 当前决策'));
  assert.ok(md.includes('mem_1'));
  assert.ok(md.includes(CONTEXT_DISCLAIMER));

  const json = JSON.parse(renderContextJson(pkg)) as {
    manifest: { items: Array<{ memory_id: string; version: number }> };
    sections: Array<{ items: Array<{ memory_id: string }> }>;
  };
  assert.equal(json.manifest.items[0]?.memory_id, 'mem_1');
  assert.equal(json.manifest.items[0]?.version, 1);
  assert.ok(json.sections.length >= 1);
});

test('按 §4.3 的分组顺序输出章节', () => {
  const selection = selectContextItems(
    [
      item({ memoryId: 'mem_h', kind: 'hypothesis', relevance: 1 }),
      item({ memoryId: 'mem_f', kind: 'fact', relevance: 1 }),
      item({ memoryId: 'mem_d', kind: 'decision', relevance: 1 }),
      item({ memoryId: 'mem_l', kind: 'lesson', relevance: 1 }),
    ],
    { allowedProjectIds: null, projectId: 'prj_a', budgetTokens: 5000 },
  );
  const pkg = buildContextPackage({
    packageId: 'ctx_3',
    projectId: 'prj_a',
    projectTitle: '项目 A',
    budgetKind: 'standard',
    selection,
    generatedAt: '2026-09-16T00:00:00.000Z',
  });
  assert.deepEqual(
    pkg.sections.map((s) => s.title),
    ['已确认事实', '当前决策', '已尝试且失败的路径 / 经验', '尚未验证的猜想'],
  );
});

test('token 估算：中文按字、英文按 4 字符', () => {
  assert.equal(estimateTokens('中文四字'), 4);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('中文 mixed content 混合') > 4);
});
