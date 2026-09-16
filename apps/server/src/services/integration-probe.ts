/**
 * 探测结果的落库。
 *
 * 从路由里抽出来有两个原因：一是它需要事务与账户校验，属于服务层的职责；
 * 二是这样它能被直接测试 —— 否则要验证「额度快照真的写进去了」，
 * 就得在测试里跑一个真的 Codex。
 */

import { tx } from '../db/database.js';
import { getAccount } from '../db/repos/registry.js';
import { insertQuotaSnapshot } from '../db/repos/quota.js';
import { ApiError } from '../http/errors.js';
import type { ServiceContext } from '../service-context.js';
import type { QuotaSnapshotDraft } from '../collectors/codex-usage.js';

export interface StoreProbeResult {
  stored: number;
  warnings: string[];
}

/**
 * 把探测到的额度快照写进库。
 *
 * 三条刻意保持的约束：
 * 1. **不自动建账户。** 没有账户就不落库并如实说明 —— 系统不会为了「让数据有地方放」
 *    造一个「未指定」账户，那会让概览里出现一个用户没建过的桶。
 * 2. **全部或全不。** 同一个观察时刻的多个窗口在一个事务里写入，避免出现
 *    「主窗口更新了、次窗口还是上一轮的」这种自相矛盾的快照。
 * 3. `collection_method` 固定为 `official_api`、质量固定 `provider_reported` ——
 *    这是本项目里可信度最高的一档，不该由调用方随意指定。
 */
export function storeProbeQuotaSnapshots(
  ctx: ServiceContext,
  accountId: string | null,
  drafts: readonly QuotaSnapshotDraft[],
  adapterVersion: string,
): StoreProbeResult {
  if (drafts.length === 0) return { stored: 0, warnings: [] };

  if (!accountId) {
    return {
      stored: 0,
      warnings: [
        `本次读到了 ${drafts.length} 个额度桶，但没有指定归属账户，因此没有入库。` +
          '额度快照必须挂在某个计费账户上 —— 系统不会替你造一个「未指定」账户。' +
          '在「用量与订阅 → 登记」里建一个账户，然后带上 accountId 重新探测。',
      ],
    };
  }

  if (!getAccount(ctx.db, accountId)) {
    throw new ApiError(404, 'not_found', `计费账户不存在：${accountId}`);
  }

  const observedAt = new Date(ctx.now()).toISOString();
  let stored = 0;
  tx(ctx.db, () => {
    for (const draft of drafts) {
      insertQuotaSnapshot(ctx.db, {
        accountId,
        bucketId: draft.bucketId,
        bucketLabel: draft.bucketLabel,
        scope: draft.scope,
        windowKind: draft.windowKind,
        windowSeconds: draft.windowSeconds,
        usedRatio: draft.usedRatio,
        remainingRatio: draft.remainingRatio,
        resetAt: draft.resetAt,
        observedAt,
        measurementQuality: 'provider_reported',
        collectionMethod: 'official_api',
        sourceRef: draft.sourceRef,
        adapterVersion,
        staleAfterSeconds: ctx.config.quotaStaleSeconds,
      });
      stored += 1;
    }
  });

  return { stored, warnings: [] };
}
