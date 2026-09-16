import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransitionMemory,
  canTransitionProposal,
  checkBaseVersion,
  diffLines,
  isContextEligible,
  isHistorySearchable,
  MEMORY_TRANSITIONS,
  proposalContentHash,
  textSimilarity,
} from '../src/memory.js';

/** 记忆生命周期与版本冲突。设计稿 §6 / §15 的 M01、M02。 */

test('M01 / INV-10：没有任何从「候选」直接进入 active 的状态迁移', () => {
  // 记忆状态机里不存在 candidate —— 候选只存在于提案表。
  assert.ok(!Object.keys(MEMORY_TRANSITIONS).includes('candidate'));
  assert.ok(!Object.values(MEMORY_TRANSITIONS).flat().includes('candidate' as never));
  // deleted 是终态
  assert.deepEqual(MEMORY_TRANSITIONS.deleted, []);
});

test('记忆状态迁移的合法与非法路径', () => {
  assert.equal(canTransitionMemory('active', 'superseded'), true);
  assert.equal(canTransitionMemory('active', 'archived'), true);
  assert.equal(canTransitionMemory('active', 'expired'), true);
  assert.equal(canTransitionMemory('archived', 'active'), true, '归档后允许恢复');
  assert.equal(canTransitionMemory('deleted', 'active'), false, '删除是终态');
  assert.equal(canTransitionMemory('active', 'active'), false, '不能原地「迁移」到自己');
});

test('只有 active 进入普通上下文；过期内容仍可在历史视图检索', () => {
  assert.equal(isContextEligible('active'), true);
  assert.equal(isContextEligible('expired'), false);
  assert.equal(isContextEligible('superseded'), false);
  assert.equal(isHistorySearchable('expired'), true);
  assert.equal(isHistorySearchable('superseded'), true);
  assert.equal(isHistorySearchable('deleted'), false);
});

test('提案状态机：conflict 是终态，必须基于新版本重新提交', () => {
  assert.equal(canTransitionProposal('pending', 'approved'), true);
  assert.equal(canTransitionProposal('pending', 'rejected'), true);
  assert.equal(canTransitionProposal('pending', 'conflict'), true);
  assert.equal(canTransitionProposal('conflict', 'pending'), false);
  assert.equal(canTransitionProposal('approved', 'pending'), false);
  assert.equal(canTransitionProposal('rejected', 'pending'), false);
});

test('M02：两个客户端基于同一旧版本更新 → 第二次审批触发冲突', () => {
  // 客户端 A：基于 v1 提交，当前仍是 v1 → 通过
  const a = checkBaseVersion('update', 1, 1);
  assert.equal(a.ok, true);
  if (!a.ok) throw new Error('不可达');
  assert.equal(a.nextVersion, 2);

  // A 批准后当前版本变成 v2；客户端 B 仍然基于 v1 提交
  const b = checkBaseVersion('update', 2, 1);
  assert.equal(b.ok, false);
  if (b.ok) throw new Error('不可达');
  assert.equal(b.code, 'base_version_mismatch');
  assert.equal(b.currentVersion, 2);
  assert.equal(b.baseVersion, 1);
  assert.match(b.message, /不会自动合并/);
});

test('INV-11：更新类提案不携带 base_version 直接拒绝', () => {
  const result = checkBaseVersion('update', 3, null);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('不可达');
  assert.equal(result.code, 'base_version_required');
});

test('更新目标已被删除 → 拒绝，不静默重建', () => {
  const result = checkBaseVersion('update', null, 1);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('不可达');
  assert.equal(result.code, 'target_missing');
});

test('create 提案的约束：目标必须不存在且 base_version 为 null', () => {
  const ok = checkBaseVersion('create', null, null);
  assert.equal(ok.ok, true);
  if (!ok.ok) throw new Error('不可达');
  assert.equal(ok.nextVersion, 1);

  const withTarget = checkBaseVersion('create', 2, null);
  assert.equal(withTarget.ok, false);
  if (withTarget.ok) throw new Error('不可达');
  assert.equal(withTarget.code, 'target_exists');

  const withBase = checkBaseVersion('create', null, 5);
  assert.equal(withBase.ok, false);
  if (withBase.ok) throw new Error('不可达');
  assert.equal(withBase.code, 'base_version_required');
});

test('归档提案同样需要 base_version', () => {
  assert.equal(checkBaseVersion('archive', 2, 2).ok, true);
  assert.equal(checkBaseVersion('archive', 2, null).ok, false);
  assert.equal(checkBaseVersion('archive', 2, 1).ok, false);
});

test('行级差异：能看出改了什么', () => {
  const before = '第一行\n第二行\n第三行';
  const after = '第一行\n第二行（改）\n第三行\n第四行';
  const diff = diffLines(before, after);

  assert.equal(diff.removed, 1);
  assert.equal(diff.added, 2);
  assert.equal(diff.unchanged, 2);
  assert.equal(diff.truncated, false);
  const rendered = diff.lines.map((l) => `${l.kind === 'add' ? '+' : l.kind === 'remove' ? '-' : ' '}${l.text}`);
  assert.deepEqual(rendered, [' 第一行', '-第二行', '+第二行（改）', ' 第三行', '+第四行']);
});

test('行级差异：整体替换时先删后增（回溯方向必须用数值比较）', () => {
  // 回归测试。这里 moveDown 与 moveRight 都是 0：
  // - 正确的数值比较 `0 >= 0` → 先输出删除
  // - 被 `as` 优先级破坏成真值判断时，`0` 为假 → 先输出新增
  // 之前的用例恰好两种写法结果相同，抓不到这个 bug。
  const diff = diffLines('a', 'b');
  assert.deepEqual(
    diff.lines.map((l) => `${l.kind}:${l.text}`),
    ['remove:a', 'add:b'],
  );

  const multi = diffLines('第一行\n第二行', '完全不同的内容');
  assert.deepEqual(
    multi.lines.map((l) => l.kind),
    ['remove', 'remove', 'add'],
  );
});

test('超长文本退化为前后缀比较，不阻塞审核界面', () => {
  const big = Array.from({ length: 2000 }, (_, i) => `行 ${i}`).join('\n');
  const diff = diffLines(big, `${big}\n新增一行`);
  assert.equal(diff.truncated, true);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 0);
});

test('完全相同的候选建议合并，语义近似只提示', () => {
  assert.equal(proposalContentHash('标题', '正文'), proposalContentHash('  标题 ', '正文\n'));
  assert.notEqual(proposalContentHash('标题', '正文'), proposalContentHash('标题', '正文2'));

  const sim = textSimilarity('优先检索已有引理再拆分新节点', '优先检索已有引理，再拆分新的节点');
  assert.ok(sim > 0.5, `相似度应较高，实际 ${sim}`);
  assert.ok(textSimilarity('完全无关的话题', '优先检索已有引理') < 0.2);
});

test('空文本差异不崩', () => {
  const diff = diffLines('', '新内容');
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 0);
  assert.equal(diffLines('', '').lines.length, 0);
});
