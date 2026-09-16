/**
 * 幂等与去重（设计稿 §5.5，不变量 INV-05 / INV-06）。
 *
 * 这里区分**两个不同的键**，这是整个用量模型最容易做错的地方：
 *
 * - `dedupeKey` —— **同批次重放**幂等。同一个文件再次导入，行不变、键不变、不新增记录。
 *   没有稳定请求 ID 时它就是行级键，所以必须带文件指纹和行号。
 *
 * - `identityKey` —— **跨来源身份**。同一个真实请求同时出现在网关、客户端日志、
 *   观测平台时，三者得到同一个键。命中后新记录作为**证据**保留，但不重复计入统计。
 *
 * 关键取舍：如果身份只靠内容指纹推断（没有稳定 ID），跨文件命中**不静默合并**，
 * 而是标为 `suspect` 待用户确认 —— 因为「两个文件里出现同样的行」既可能是同一请求，
 * 也可能是两次真实发生但内容相同的请求（§5.5 明确不允许悄悄删掉）。
 */

import { contentFingerprint } from './ids.js';
import type { MeterKind } from './enums.js';

export type IdentityConfidence =
  /** 有稳定请求 ID。命中即可确定是同一个请求。 */
  | 'stable_id'
  /** 只有内容指纹。命中只能说明「看起来是同一个请求」。 */
  | 'content_fingerprint'
  /** 信息不足以构造任何身份键。 */
  | 'none';

export interface DedupeInput {
  accountId: string | null;
  providerRequestId?: string | null;
  meterKind: MeterKind;
  /** 本次导入的文件指纹；手动录入时为 null。 */
  fileFingerprint?: string | null;
  /** 手动录入或 CSV 行号。 */
  rowIndex?: number | null;
  /** 以下字段参与内容指纹构造。 */
  model?: string | null;
  occurredAt?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  inputTotal?: number | null;
  outputTotal?: number | null;
  totalReported?: number | null;
  coverageScope?: string | null;
  rawUsage?: unknown;
}

export interface DedupeKeys {
  dedupeKey: string;
  identityKey: string;
  identityConfidence: IdentityConfidence;
}

const SEP = '\u001f';

function reqKey(accountId: string | null, providerRequestId: string, meterKind: string): string {
  return `req${SEP}${accountId ?? 'unassigned'}${SEP}${providerRequestId}${SEP}${meterKind}`;
}

/** 参与内容指纹的「实质字段」。像 `row_index` 这类定位信息不参与。 */
function significantPayload(input: DedupeInput): Record<string, unknown> {
  return {
    account: input.accountId ?? null,
    meter: input.meterKind,
    model: input.model ?? null,
    occurredAt: input.occurredAt ?? null,
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
    inputTotal: input.inputTotal ?? null,
    outputTotal: input.outputTotal ?? null,
    totalReported: input.totalReported ?? null,
    coverage: input.coverageScope ?? null,
    raw: input.rawUsage ?? null,
  };
}

export function computeDedupeKeys(input: DedupeInput): DedupeKeys {
  const payload = significantPayload(input);
  const fp = contentFingerprint(payload);

  // dedupeKey 永远带「批次 + 行定位 + 内容」，与有没有请求 ID 无关。
  //
  // 曾经把 dedupeKey 和 identityKey 在有请求 ID 时设成同一个值，结果是：
  // 同一个请求被网关和客户端日志分别采到之后，第二条因为「去重键重复」被当成重放直接跳过，
  // 证据行根本没有落库 —— 表面上 U04 的「只计一次」满足了，实际上「保留多来源证据」丢了。
  // 两个键的职责必须彻底分开：dedupeKey 管「这一行走过没有」，identityKey 管「这是不是同一个请求」。
  const file = input.fileFingerprint ?? 'manual';
  const row = input.rowIndex ?? 'seq';
  const dedupeKey = `batch${SEP}${file}${SEP}${row}${SEP}${fp}`;

  const requestId = input.providerRequestId?.trim();
  if (requestId) {
    return {
      dedupeKey,
      identityKey: reqKey(input.accountId, requestId, input.meterKind),
      identityConfidence: 'stable_id',
    };
  }

  const hasAnySignal =
    input.model != null ||
    input.occurredAt != null ||
    input.periodStart != null ||
    input.totalReported != null ||
    input.inputTotal != null ||
    input.outputTotal != null ||
    input.rawUsage != null;

  if (!hasAnySignal) {
    // 什么信号都没有：不允许伪造一个身份键让不同记录互相顶掉。
    return { dedupeKey, identityKey: `anon${SEP}${dedupeKey}`, identityConfidence: 'none' };
  }

  return { dedupeKey, identityKey: `fp${SEP}${fp}`, identityConfidence: 'content_fingerprint' };
}

/** 已有主记录的最小信息，用于判定新记录与它的关系。 */
export interface ExistingObservationRef {
  id: string;
  dedupeKey: string;
  identityKey: string;
  /** 该主记录来自哪个导入批次的文件指纹（手动录入为 null）。 */
  fileFingerprint?: string | null;
}

export type DuplicateDecision =
  /** 全新记录，应作为主统计源。 */
  | { kind: 'new' }
  /** 同一批次/同文件的完全重放：直接跳过，不新增行（INV-05）。 */
  | { kind: 'replay'; existingId: string; reason: string }
  /** 跨来源命中稳定 ID：保留为证据，不计入统计（INV-06）。 */
  | { kind: 'evidence'; duplicateOf: string; reason: string }
  /** 仅靠内容指纹命中且来自不同文件：标为待确认，两个都保留（§5.5）。 */
  | { kind: 'suspect'; duplicateOf: string; reason: string };

export function classifyDuplicate(
  incoming: DedupeKeys & { fileFingerprint?: string | null },
  existing: {
    byDedupeKey?: ExistingObservationRef | undefined;
    byIdentityKey?: ExistingObservationRef | undefined;
  },
): DuplicateDecision {
  // 完全相同的批次 + 行定位 + 内容 → 就是重放，直接跳过（U01 / INV-05）
  const sameDedupe = existing.byDedupeKey;
  if (sameDedupe) {
    return {
      kind: 'replay',
      existingId: sameDedupe.id,
      reason: '同一批次、同一行定位且内容一致，判定为重复导入',
    };
  }

  const sameIdentity = existing.byIdentityKey;
  if (sameIdentity) {
    if (incoming.identityConfidence === 'stable_id') {
      return {
        kind: 'evidence',
        duplicateOf: sameIdentity.id,
        reason: '命中稳定请求 ID，判定为同一请求的另一个来源，仅作证据保留',
      };
    }
    return {
      kind: 'suspect',
      duplicateOf: sameIdentity.id,
      reason: '不同文件中出现相同内容指纹，但缺少稳定请求 ID，无法确认是否为同一请求',
    };
  }

  return { kind: 'new' };
}

/**
 * 统计口径选择：只有 `isPrimary = 1` 的记录计入总量。
 * `suspect` 与 `evidence` 均为 `isPrimary = 0`（INV-04）。
 */
export function isCountedInTotals(row: { isPrimary: boolean; duplicateStatus: string }): boolean {
  if (!row.isPrimary) return false;
  return row.duplicateStatus === 'none' || row.duplicateStatus === 'resolved_unique';
}
