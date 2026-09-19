/**
 * 用量服务：手动录入、CSV / JSON 导入、去重决策、收费登记。
 *
 * 这里是 U01～U06 的实现处。三条关键约定：
 *
 * 1. **未知不等于零。** 没有数值就是 `null`，字段缺失不会被补成 0（INV-01）。
 * 2. **子项不重复相加。** 总量 = input + output，cached / reasoning 只作为明细（INV-02）。
 * 3. **同一条事实只计一次。** 但「只计一次」不等于「只存一份」——
 *    其他来源作为证据保留下来，界面能看见「这一条有 3 个来源」。
 */

import {
  aggregateTokens,
  classifyDuplicate,
  computeDedupeKeys,
  contentFingerprint,
  fileFingerprint,
  moneyFromDecimal,
  normalizeOpenAiLike,
  type CollectionMethod,
  type MeasurementQuality,
  type MeterKind,
  type NormalizedTokens,
  type ObservationKind,
} from '@aicc/core';
import { TxAbort, tx } from '../db/database.js';
import {
  countSuspectDuplicates,
  findByDedupeKey,
  findFirstByIdentityKey,
  findPrimaryByIdentityKey,
  insertCharge as repoInsertCharge,
  insertObservation,
  listCharges,
  listObservations,
  countedObservations,
  resolveDuplicate,
  type Charge,
  type UsageObservation,
  type UsageQuery,
} from '../db/repos/usage.js';
import { insertSource } from '../db/repos/memory.js';
import {
  createImportJob,
  findCompletedImportByFingerprint,
  finishImportJob,
} from '../db/repos/system.js';
import { guardImportPayload } from '../imports/guard.js';
import type { WorkspaceScope } from '../db/repos/workspace.js';
import { mapColumns, parseCsv, parseJsonRecords, CHARGE_COLUMN_SPECS, USAGE_COLUMN_SPECS } from '../imports/parse.js';
import type { ServiceContext } from '../service-context.js';
import { audit } from './audit.js';

const ADAPTER_ID = 'generic-tabular';
const ADAPTER_VERSION = '1.0.0';

/* ------------------------------------------------------------------ */
/* 数值解析                                                            */
/* ------------------------------------------------------------------ */

interface ParsedNumber {
  value: number | null;
  /** 原始文本非空，但无法解析成整数时有值 —— 用于给出「这一行有问题」的警告。 */
  invalidText?: string;
}

function parseCount(text: string | undefined): ParsedNumber {
  if (text === undefined) return { value: null };
  const t = text.trim();
  if (t.length === 0) return { value: null };
  if (!/^\d+$/.test(t)) return { value: null, invalidText: t };
  const n = Number(t);
  if (!Number.isSafeInteger(n)) return { value: null, invalidText: t };
  return { value: n };
}

function parseTimestamp(text: string | undefined): { value: string | null; invalidText?: string } {
  if (text === undefined) return { value: null };
  const t = text.trim();
  if (t.length === 0) return { value: null };
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return { value: null, invalidText: t };
  return { value: new Date(ms).toISOString() };
}

/**
 * 把映射后的字段组装成一份「子集语义」的原始对象，再交给 core 统一归一化。
 *
 * 走同一条归一化路径（而不是在这里另写一套加法）很重要：
 * U02 的规则只能有一处实现，否则两处迟早会分叉。
 */
function tokensFromMapped(mapped: Record<string, string>): { tokens: NormalizedTokens; issues: string[] } {
  const issues: string[] = [];
  const raw: Record<string, unknown> = {};

  const set = (key: string, parsed: ParsedNumber, label: string): void => {
    if (parsed.invalidText !== undefined) {
      issues.push(`${label}（${JSON.stringify(parsed.invalidText)}）不是非负整数，该字段按未知处理`);
      return;
    }
    if (parsed.value !== null) raw[key] = parsed.value;
  };

  set('input_tokens', parseCount(mapped.inputTotal), '输入 token');
  set('output_tokens', parseCount(mapped.outputTotal), '输出 token');
  set('total_tokens', parseCount(mapped.totalReported), '供应商自报总量');
  set('cached_tokens', parseCount(mapped.cachedInput), '缓存输入 token');
  set('reasoning_tokens', parseCount(mapped.reasoningOutput), '推理输出 token');
  set('cache_creation_input_tokens', parseCount(mapped.cacheWriteInput), '缓存写入 token');

  return { tokens: normalizeOpenAiLike(raw), issues };
}

/* ------------------------------------------------------------------ */
/* 一行用量的处理                                                      */
/* ------------------------------------------------------------------ */

export interface RowContext {
  accountId: string | null;
  projectId: string | null;
  clientId: string | null;
  fileFingerprint: string;
  importJobId: string | null;
  collectionMethod: CollectionMethod;
  measurementQuality: MeasurementQuality;
  coverageScope: string | null;
  dryRun: boolean;
  isDemo?: boolean;
}

export type RowOutcome =
  | { status: 'accepted'; observation: UsageObservation; warnings: string[] }
  | { status: 'replay'; observation: UsageObservation; warnings: string[] }
  | { status: 'evidence'; observation: UsageObservation; duplicateOf: string; warnings: string[] }
  | { status: 'suspect'; observation: UsageObservation; duplicateOf: string; warnings: string[] }
  | { status: 'rejected'; reason: string; warnings: string[] };

/**
 * 处理一行用量数据。
 *
 * 流程：解析数值 → 归一化 → 计算两个键 → 判定与已有记录的关系 → 落库。
 * 四种结果都不「丢数据」：replay 跳过是因为内容完全一致，
 * evidence / suspect 都会留下行，只是 `is_primary = 0` 不进统计。
 */
export function processUsageRow(
  ctx: ServiceContext,
  raw: Record<string, unknown>,
  mapped: Record<string, string>,
  rowIndex: number,
  rc: RowContext,
): RowOutcome {
  const warnings: string[] = [];
  const { tokens, issues } = tokensFromMapped(mapped);
  warnings.push(...issues);

  const hasAnyNumber =
    tokens.inputTotal !== null ||
    tokens.outputTotal !== null ||
    tokens.totalReported !== null ||
    parseCount(mapped.requests).value !== null;

  if (!hasAnyNumber) {
    return {
      status: 'rejected',
      reason: '该行没有可识别的用量数值（输入/输出/总量/请求数全为空或无法解析）',
      warnings,
    };
  }

  if (tokens.inputTotal === null && tokens.outputTotal === null && tokens.totalReported !== null) {
    warnings.push(
      '该行只提供了总量，缺少输入/输出分量。总量按供应商自报值保留，但无法核对子集语义（缓存 / 推理是否重复计入）。',
    );
  }

  const occurred = parseTimestamp(mapped.occurredAt);
  if (occurred.invalidText !== undefined) {
    warnings.push(`时间字段 ${JSON.stringify(occurred.invalidText)} 无法解析，按「时间未知」处理，不伪造时刻`);
  }
  const periodStart = parseTimestamp(mapped.periodStart);
  const periodEnd = parseTimestamp(mapped.periodEnd);

  const providerRequestId = mapped.providerRequestId?.trim() ? mapped.providerRequestId.trim() : null;

  const hasPeriod = periodStart.value !== null || periodEnd.value !== null;
  const kind: ObservationKind = hasPeriod ? 'summary' : 'event';
  if (hasPeriod) {
    warnings.push('该行包含周期字段，按「账户汇总」记录。汇总与事件明细不会同时计入同一覆盖范围。');
  }

  const meterKind: MeterKind = 'tokens';
  const keys = computeDedupeKeys({
    accountId: rc.accountId,
    providerRequestId,
    meterKind,
    fileFingerprint: rc.fileFingerprint,
    rowIndex,
    model: mapped.model ?? null,
    occurredAt: occurred.value,
    periodStart: periodStart.value,
    periodEnd: periodEnd.value,
    inputTotal: tokens.inputTotal,
    outputTotal: tokens.outputTotal,
    totalReported: tokens.totalReported,
    coverageScope: rc.coverageScope,
    rawUsage: raw,
  });

  const existingByDedupe = findByDedupeKey(ctx.db, keys.dedupeKey);
  const existingByIdentity = providerRequestId
    ? findPrimaryByIdentityKey(ctx.db, keys.identityKey) ?? findFirstByIdentityKey(ctx.db, keys.identityKey)
    : findFirstByIdentityKey(ctx.db, keys.identityKey);

  const decision = classifyDuplicate(
    { ...keys, fileFingerprint: rc.fileFingerprint },
    {
      byDedupeKey: existingByDedupe
        ? {
            id: existingByDedupe.id,
            dedupeKey: existingByDedupe.dedupeKey,
            identityKey: existingByDedupe.identityKey,
            fileFingerprint: existingByDedupe.fileFingerprint,
          }
        : undefined,
      byIdentityKey: existingByIdentity
        ? {
            id: existingByIdentity.id,
            dedupeKey: existingByIdentity.dedupeKey,
            identityKey: existingByIdentity.identityKey,
            fileFingerprint: existingByIdentity.fileFingerprint,
          }
        : undefined,
    },
  );

  // 用户显式声明的依据优先；行内声明可以覆盖。
  const measurementQuality = normalizeQuality(mapped.measurementQuality) ?? rc.measurementQuality;
  const collectionMethod = normalizeMethod(mapped.collectionMethod) ?? rc.collectionMethod;

  const base = {
    kind,
    collectionMethod,
    measurementQuality,
    accountId: rc.accountId,
    projectId: rc.projectId,
    clientId: rc.clientId,
    model: mapped.model?.trim() ? mapped.model.trim() : null,
    occurredAt: occurred.value,
    periodStart: periodStart.value,
    periodEnd: periodEnd.value,
    rawUsage: raw,
    tokens,
    sourceRef: mapped.sourceRef?.trim() ? mapped.sourceRef.trim() : null,
    adapterVersion: ADAPTER_VERSION,
    coverageScope: rc.coverageScope,
    providerRequestId,
    meterKind,
    dedupeKey: keys.dedupeKey,
    identityKey: keys.identityKey,
    identityConfidence: keys.identityConfidence,
    importJobId: rc.importJobId,
    rowIndex,
    fileFingerprint: rc.fileFingerprint,
    contentFingerprint: contentFingerprint(raw),
    isDemo: rc.isDemo,
  } as const;

  if (rc.dryRun) {
    // 预检模式不落库。仍然返回判定结果，让用户先看清会发生什么。
    // 这里把「行里已经定下来的东西」和「入库时才产生的字段」显式分开写全，
    // 而不是 `as UsageObservation` 硬转 —— 硬转会掩盖「字段漏填」这类错误。
    const preview: UsageObservation = {
      id: 'preview',
      kind,
      collectionMethod,
      measurementQuality,
      accountId: rc.accountId,
      projectId: rc.projectId,
      clientId: rc.clientId,
      model: base.model,
      occurredAt: base.occurredAt,
      periodStart: base.periodStart,
      periodEnd: base.periodEnd,
      rawUsage: raw,
      inputTotal: tokens.inputTotal,
      outputTotal: tokens.outputTotal,
      totalReported: tokens.totalReported,
      cachedInput: tokens.cachedInput,
      reasoningOutput: tokens.reasoningOutput,
      cacheWriteInput: tokens.cacheWriteInput,
      normalizationBasis: tokens.basis,
      normalizationNotes: tokens.warnings,
      sourceRef: base.sourceRef,
      adapterVersion: ADAPTER_VERSION,
      coverageScope: rc.coverageScope,
      providerRequestId,
      meterKind,
      dedupeKey: keys.dedupeKey,
      identityKey: keys.identityKey,
      identityConfidence: keys.identityConfidence,
      isPrimary: decision.kind === 'new',
      duplicateStatus:
        decision.kind === 'suspect' ? 'suspect' : decision.kind === 'evidence' ? 'merged_evidence' : 'none',
      duplicateOf: decision.kind === 'evidence' || decision.kind === 'suspect' ? decision.duplicateOf : null,
      importJobId: rc.importJobId,
      rowIndex,
      fileFingerprint: rc.fileFingerprint,
      contentFingerprint: base.contentFingerprint,
      observedAt: new Date(ctx.now()).toISOString(),
      isDemo: rc.isDemo === true,
    };

    if (decision.kind === 'replay') return { status: 'replay', observation: preview, warnings };
    if (decision.kind === 'evidence') {
      return { status: 'evidence', observation: preview, duplicateOf: decision.duplicateOf, warnings };
    }
    if (decision.kind === 'suspect') {
      return { status: 'suspect', observation: preview, duplicateOf: decision.duplicateOf, warnings };
    }
    return { status: 'accepted', observation: preview, warnings };
  }

  if (decision.kind === 'replay') {
    const existing = existingByDedupe as UsageObservation;
    return { status: 'replay', observation: existing, warnings };
  }

  if (decision.kind === 'evidence') {
    const inserted = insertObservation(ctx.db, {
      ...base,
      isPrimary: false,
      duplicateStatus: 'merged_evidence',
      duplicateOf: decision.duplicateOf,
    });
    return {
      status: 'evidence',
      observation: inserted,
      duplicateOf: decision.duplicateOf,
      warnings: [...warnings, decision.reason],
    };
  }

  if (decision.kind === 'suspect') {
    const inserted = insertObservation(ctx.db, {
      ...base,
      isPrimary: false,
      duplicateStatus: 'suspect',
      duplicateOf: decision.duplicateOf,
    });
    return {
      status: 'suspect',
      observation: inserted,
      duplicateOf: decision.duplicateOf,
      warnings: [...warnings, decision.reason, '已标为待确认，未计入统计。请在「用量与订阅」页确认这是两条真实请求还是同一个请求。'],
    };
  }

  const inserted = insertObservation(ctx.db, {
    ...base,
    isPrimary: true,
    duplicateStatus: 'none',
    duplicateOf: null,
  });
  return { status: 'accepted', observation: inserted, warnings };
}

function normalizeQuality(value: string | undefined): MeasurementQuality | null {
  const v = (value ?? '').trim();
  if (v === 'provider_reported' || v === 'locally_observed' || v === 'estimated' || v === 'unknown') return v;
  return null;
}

function normalizeMethod(value: string | undefined): CollectionMethod | null {
  const v = (value ?? '').trim();
  if (v === 'official_api' || v === 'local_log' || v === 'imported_file' || v === 'manual') return v;
  return null;
}

/* ------------------------------------------------------------------ */
/* 手动录入                                                            */
/* ------------------------------------------------------------------ */

export interface ManualUsageInput {
  kind: ObservationKind;
  accountId: string | null;
  projectId: string | null;
  clientId: string | null;
  model?: string | null;
  occurredAt?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  providerRequestId?: string | null;
  meterKind: MeterKind;
  rawUsage: Record<string, unknown>;
  basis: 'openai_inclusive' | 'exclusive_buckets' | 'unknown';
  measurementQuality: MeasurementQuality;
  coverageScope?: string | null;
  sourceRef?: string | null;
}

export function recordManualUsage(ctx: ServiceContext, input: ManualUsageInput): UsageObservation {
  return tx(ctx.db, () => {
    const tokens =
      input.basis === 'openai_inclusive'
        ? normalizeOpenAiLike(input.rawUsage)
        : { ...normalizeOpenAiLike({}), basis: input.basis };

    const keys = computeDedupeKeys({
      accountId: input.accountId,
      providerRequestId: input.providerRequestId ?? null,
      meterKind: input.meterKind,
      fileFingerprint: null,
      rowIndex: null,
      model: input.model ?? null,
      occurredAt: input.occurredAt ?? null,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      inputTotal: tokens.inputTotal,
      outputTotal: tokens.outputTotal,
      totalReported: tokens.totalReported,
      coverageScope: input.coverageScope ?? null,
      rawUsage: input.rawUsage,
    });

    const existingByDedupe = findByDedupeKey(ctx.db, keys.dedupeKey);
    const existingByIdentity = findFirstByIdentityKey(ctx.db, keys.identityKey);
    const decision = classifyDuplicate(
      { ...keys, fileFingerprint: null },
      {
        byDedupeKey: existingByDedupe
          ? {
              id: existingByDedupe.id,
              dedupeKey: existingByDedupe.dedupeKey,
              identityKey: existingByDedupe.identityKey,
              fileFingerprint: existingByDedupe.fileFingerprint,
            }
          : undefined,
        byIdentityKey: existingByIdentity
          ? {
              id: existingByIdentity.id,
              dedupeKey: existingByIdentity.dedupeKey,
              identityKey: existingByIdentity.identityKey,
              fileFingerprint: existingByIdentity.fileFingerprint,
            }
          : undefined,
      },
    );

    if (decision.kind === 'replay') {
      audit(ctx, {
        action: 'usage.dedupe',
        entityType: 'usage_observation',
        entityId: existingByDedupe?.id ?? null,
        result: 'rejected',
        detail: { reason: 'manual_replay', dedupeKey: keys.dedupeKey },
      });
      throw new TxAbort('duplicate_entry', '这条用量与已有记录完全一致，未重复登记。');
    }

    const observation = insertObservation(ctx.db, {
      kind: input.kind,
      collectionMethod: 'manual',
      measurementQuality: input.measurementQuality,
      accountId: input.accountId,
      projectId: input.projectId,
      clientId: input.clientId,
      model: input.model ?? null,
      occurredAt: input.occurredAt ?? null,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      rawUsage: input.rawUsage,
      tokens,
      sourceRef: input.sourceRef ?? null,
      adapterVersion: 'manual-1.0.0',
      coverageScope: input.coverageScope ?? null,
      providerRequestId: input.providerRequestId ?? null,
      meterKind: input.meterKind,
      dedupeKey: keys.dedupeKey,
      identityKey: keys.identityKey,
      identityConfidence: keys.identityConfidence,
      isPrimary: true,
      duplicateStatus: 'none',
      duplicateOf: null,
      importJobId: null,
      rowIndex: null,
      fileFingerprint: null,
      contentFingerprint: contentFingerprint(input.rawUsage),
    });

    audit(ctx, {
      action: 'usage.observe',
      entityType: 'usage_observation',
      entityId: observation.id,
      detail: {
        kind: observation.kind,
        collectionMethod: 'manual',
        measurementQuality: observation.measurementQuality,
        totalReported: observation.totalReported,
        inputTotal: observation.inputTotal,
        outputTotal: observation.outputTotal,
      },
    });

    return observation;
  });
}

/* ------------------------------------------------------------------ */
/* 文件导入                                                            */
/* ------------------------------------------------------------------ */

export interface ImportInput {
  kind: 'usage_csv' | 'usage_json' | 'charge_csv' | 'memory_json';
  fileName: string;
  content: string;
  accountId: string | null;
  projectId: string | null;
  clientId: string | null;
  collectionMethod: CollectionMethod;
  measurementQuality: MeasurementQuality;
  coverageScope: string | null;
  dryRun: boolean;
  isDemo?: boolean;
}

export interface ImportOutcome {
  jobId: string;
  status: string;
  fileName: string;
  fileFingerprint: string;
  dryRun: boolean;
  totalRows: number;
  acceptedRows: number;
  replayedRows: number;
  evidenceRows: number;
  suspectRows: number;
  rejectedRows: number;
  warnings: string[];
  errors: Array<{ row: number; message: string }>;
  /** 本次新增/待确认的记录 ID，便于前端跳转查看。 */
  affectedObservationIds: string[];
  /** 该文件此前是否成功导入过。 */
  previousImport: { jobId: string; finishedAt: string | null; acceptedRows: number } | null;
}

export function importData(ctx: ServiceContext, input: ImportInput): ImportOutcome {
  const allowed =
    input.kind === 'usage_json' || input.kind === 'memory_json' ? ['.json'] : ['.csv', '.tsv', '.txt'];

  const guard = guardImportPayload(input.fileName, input.content, {
    maxBytes: ctx.config.maxImportBytes,
    allowedExtensions: allowed,
  });
  if (!guard.ok) {
    throw new TxAbort('import_rejected', guard.message);
  }

  const fp = fileFingerprint(input.fileName, input.content);
  const previous = findCompletedImportByFingerprint(ctx.db, input.kind, fp);

  if (input.kind === 'memory_json') {
    throw new TxAbort('wrong_endpoint', '记忆候选 JSON 请使用 /api/memory-proposals/import 导入，此处只处理用量与收费。');
  }

  return tx(ctx.db, () => {
    const job = createImportJob(ctx.db, {
      kind: input.kind,
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      fileName: input.fileName,
      fileFingerprint: fp,
      byteSize: guard.bytes,
      status: 'running',
      dryRun: input.dryRun,
      accountId: input.accountId,
      projectId: input.projectId,
      clientId: input.clientId,
      isDemo: input.isDemo,
    });

    const warnings: string[] = [...guard.notices];
    const errors: Array<{ row: number; message: string }> = [];
    const affected: string[] = [];

    let records: Array<{ raw: Record<string, unknown>; flat: Record<string, string> }> = [];

    if (input.kind === 'usage_json') {
      const parsed = parseJsonRecords(input.content);
      warnings.push(...parsed.warnings);
      records = parsed.records.map((r) => ({ raw: r, flat: stringifyValues(r) }));
    } else {
      const table = parseCsv(input.content);
      warnings.push(...table.warnings);
      records = table.rows.map((r) => ({ raw: r, flat: r }));
    }

    if (records.length > ctx.config.maxImportRows) {
      throw new TxAbort(
        'import_too_many_rows',
        `文件包含 ${records.length} 行，超过单次导入上限 ${ctx.config.maxImportRows} 行。请拆分后再导入。`,
      );
    }

    const specs = input.kind === 'charge_csv' ? CHARGE_COLUMN_SPECS : USAGE_COLUMN_SPECS;
    const unknownColumns = new Set<string>();
    const ambiguous = new Set<string>();

    let accepted = 0;
    let replayed = 0;
    let evidence = 0;
    let suspect = 0;
    let rejected = 0;

    for (let i = 0; i < records.length; i += 1) {
      const record = records[i] as { raw: Record<string, unknown>; flat: Record<string, string> };
      const mappedResult = mapColumns(record.flat, specs);
      for (const col of mappedResult.unknownColumns) unknownColumns.add(col);
      for (const a of mappedResult.ambiguous) {
        ambiguous.add(`字段 ${a.field} 命中多列，使用 ${a.usedColumn}，忽略 ${a.ignoredColumns.join('、')}`);
      }

      if (input.kind === 'charge_csv') {
        const outcome = processChargeRow(ctx, record.raw, mappedResult.mapped, i + 2, {
          accountId: input.accountId,
          jobId: job.id,
          collectionMethod: input.collectionMethod,
          measurementQuality: input.measurementQuality,
          dryRun: input.dryRun,
          isDemo: input.isDemo,
        });
        if (outcome.status === 'inserted') accepted += 1;
        else if (outcome.status === 'duplicate') replayed += 1;
        else {
          rejected += 1;
          errors.push({ row: i + 2, message: outcome.reason });
        }
        continue;
      }

      const outcome = processUsageRow(ctx, record.raw, mappedResult.mapped, i + 2, {
        accountId: input.accountId,
        projectId: input.projectId,
        clientId: input.clientId,
        fileFingerprint: fp,
        importJobId: job.id,
        collectionMethod: input.collectionMethod,
        measurementQuality: input.measurementQuality,
        coverageScope: input.coverageScope,
        dryRun: input.dryRun,
        isDemo: input.isDemo,
      });

      switch (outcome.status) {
        case 'accepted':
          accepted += 1;
          affected.push(outcome.observation.id);
          break;
        case 'replay':
          replayed += 1;
          break;
        case 'evidence':
          evidence += 1;
          affected.push(outcome.observation.id);
          break;
        case 'suspect':
          suspect += 1;
          affected.push(outcome.observation.id);
          break;
        case 'rejected':
          rejected += 1;
          errors.push({ row: i + 2, message: outcome.reason });
          break;
      }
      if (outcome.warnings.length > 0) {
        for (const w of outcome.warnings) warnings.push(`第 ${i + 2} 行：${w}`);
      }
    }

    if (unknownColumns.size > 0) {
      warnings.push(
        `以下列未被识别，原始值已完整保存在 raw_usage 中（未猜测其含义）：${[...unknownColumns].join('、')}`,
      );
    }
    for (const a of ambiguous) warnings.push(a);

    if (replayed > 0) {
      warnings.push(
        `有 ${replayed} 行与已有记录完全一致，已跳过。这通常说明同一个文件被导入过两次，token 与金额不会因此翻倍（U01）。`,
      );
    }
    if (evidence > 0) {
      warnings.push(`有 ${evidence} 行命中稳定请求 ID，判定为同一请求的其他来源，仅作为证据保留，不计入统计（U04）。`);
    }
    if (suspect > 0) {
      warnings.push(
        `有 ${suspect} 行缺少稳定请求 ID 但内容与已有记录相同，已标为待确认。它们既没有被静默合并，也没有被丢弃。`,
      );
    }

    const status = rejected === 0 ? 'completed' : accepted + evidence + suspect > 0 ? 'completed' : 'failed';
    const finished = finishImportJob(ctx.db, job.id, {
      status,
      totalRows: records.length,
      acceptedRows: accepted,
      replayedRows: replayed,
      evidenceRows: evidence,
      suspectRows: suspect,
      rejectedRows: rejected,
      warnings,
      errorReport: errors.slice(0, 200),
    });

    audit(ctx, {
      action: rejected > 0 && accepted === 0 ? 'import.fail' : 'import.complete',
      entityType: 'import_job',
      entityId: job.id,
      result: rejected > 0 && accepted === 0 ? 'failed' : 'ok',
      detail: {
        kind: input.kind,
        fileName: input.fileName,
        fileFingerprint: fp,
        dryRun: input.dryRun,
        totalRows: records.length,
        accepted,
        replayed,
        evidence,
        suspect,
        rejected,
      },
      isDemo: input.isDemo,
    });

    if (!input.dryRun && accepted + evidence + suspect > 0) {
      const sourceKind = input.collectionMethod === 'imported_file' ? 'imported_file' : 'local_log';
      insertSource(ctx.db, {
        kind: sourceKind,
        locator: input.fileName,
        contentFingerprint: fp,
        retention: 'keep',
        isDemo: input.isDemo,
      });
    }

    return {
      jobId: finished.id,
      status: finished.status,
      fileName: input.fileName,
      fileFingerprint: fp,
      dryRun: input.dryRun,
      totalRows: records.length,
      acceptedRows: accepted,
      replayedRows: replayed,
      evidenceRows: evidence,
      suspectRows: suspect,
      rejectedRows: rejected,
      warnings: dedupeStrings(warnings),
      errors,
      affectedObservationIds: affected,
      previousImport: previous
        ? { jobId: previous.id, finishedAt: previous.finishedAt, acceptedRows: previous.acceptedRows }
        : null,
    };
  });
}

/** JSON 记录里的嵌套值转成字符串表格，让 JSON 与 CSV 走同一条映射路径。 */
function stringifyValues(record: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === 'created' && typeof v === 'number' && Number.isFinite(v)) {
      const created = new Date(v * 1000);
      out[k] = Number.isNaN(created.getTime()) ? String(v) : created.toISOString();
    } else if (v === null || v === undefined) out[k] = '';
    else if (typeof v === 'object') out[k] = JSON.stringify(v);
    else out[k] = String(v);
  }

  // DeepSeek/OpenAI 风格响应把计数放在 record.usage。只展开明确的 token 字段，
  // 不递归展开 metadata，也不覆盖顶层同名字段；原始嵌套对象仍完整保存在 raw_usage。
  const usage = record.usage;
  if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
    const fields: Array<[string, string]> = [
      ['input_tokens', 'input_tokens'],
      ['prompt_tokens', 'prompt_tokens'],
      ['output_tokens', 'output_tokens'],
      ['completion_tokens', 'completion_tokens'],
      ['total_tokens', 'total_tokens'],
      ['cached_tokens', 'cached_tokens'],
      ['prompt_cache_hit_tokens', 'cached_tokens'],
      ['reasoning_tokens', 'reasoning_tokens'],
    ];
    for (const [source, target] of fields) {
      if (Object.hasOwn(out, target)) continue;
      const value = (usage as Record<string, unknown>)[source];
      if (value === null || value === undefined || typeof value === 'object') continue;
      out[target] = String(value);
    }
  }
  return out;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 收费行的处理                                                        */
/* ------------------------------------------------------------------ */

/**
 * 收费行的处理结果。
 *
 * 用可判别联合而不是「一堆可选字段」：这样 `rejected` 分支里的 `reason` 在类型上
 * 必然存在，调用方不会写出 `errors.push({ message: outcome.reason })` 这种
 * 编译期看不出来、运行期才出现 `undefined` 的代码。
 */
type ChargeOutcome =
  | { status: 'inserted'; charge?: Charge }
  | { status: 'duplicate'; reason: string; charge: Charge }
  | { status: 'rejected'; reason: string };


function processChargeRow(
  ctx: ServiceContext,
  raw: Record<string, unknown>,
  mapped: Record<string, string>,
  rowIndex: number,
  rc: {
    accountId: string | null;
    jobId: string;
    collectionMethod: CollectionMethod;
    measurementQuality: MeasurementQuality;
    dryRun: boolean;
    isDemo?: boolean;
  },
): ChargeOutcome {
  const amountText = (mapped.amount ?? '').trim();
  const currency = (mapped.currency ?? '').trim().toUpperCase();

  if (amountText.length === 0) return { status: 'rejected', reason: '缺少金额字段' };
  if (!/^-?\d+(\.\d+)?$/.test(amountText)) {
    return { status: 'rejected', reason: `金额 ${JSON.stringify(amountText)} 不是合法的十进制数` };
  }
  if (currency.length === 0) {
    return { status: 'rejected', reason: '缺少币种字段。不同币种不能相加，因此币种是必填项。' };
  }

  let money;
  try {
    money = moneyFromDecimal(amountText, currency);
  } catch (err) {
    return { status: 'rejected', reason: err instanceof Error ? err.message : String(err) };
  }

  const periodStart = parseTimestamp(mapped.periodStart);
  const paidAt = parseTimestamp(mapped.occurredAt);
  const kindRaw = (mapped.kind ?? '').trim();
  const kind = kindRaw === 'subscription' || kindRaw === 'api' || kindRaw === 'extra' || kindRaw === 'refund' ? kindRaw : 'api';
  const statusRaw = (mapped.status ?? 'unknown').trim();
  const status =
    statusRaw === 'paid' || statusRaw === 'pending' || statusRaw === 'refunded' || statusRaw === 'void' ? statusRaw : 'unknown';

  const dedupeKey = `charge${'\u001f'}${rc.jobId}${'\u001f'}${rowIndex}${'\u001f'}${contentFingerprint(raw)}`;

  if (rc.dryRun) {
    // 预检模式下不去查重（收费通过 billing_ref / 订阅周期去重，需要写库才能真正判定），
    // 因此这里只报告「这一行会被登记」，不谎称「已确认不重复」。
    return { status: 'inserted' };
  }

  const result = repoInsertCharge(ctx.db, {    accountId: rc.accountId,
    subscriptionId: null,
    kind,
    amountMinor: money.amountMinor,
    currency: money.currency,
    status,
    periodStart: periodStart.value ? periodStart.value.slice(0, 10) : null,
    periodEnd: parseTimestamp(mapped.periodEnd).value?.slice(0, 10) ?? null,
    paidAt: paidAt.value,
    billingRef: mapped.billingRef?.trim() ? mapped.billingRef.trim() : null,
    collectionMethod: rc.collectionMethod,
    measurementQuality: rc.measurementQuality,
    sourceRef: mapped.sourceRef?.trim() ? mapped.sourceRef.trim() : null,
    dedupeKey,
    note: mapped.note?.trim() ? mapped.note.trim() : null,
    isDemo: rc.isDemo,
  });

  if (result.kind === 'duplicate') {
    return { status: 'duplicate', reason: result.reason, charge: result.existing };
  }

  audit(ctx, {
    action: 'charge.create',
    entityType: 'charge',
    entityId: result.charge.id,
    detail: { kind, amountMinor: money.amountMinor, currency: money.currency, status },
    isDemo: rc.isDemo,
  });
  return { status: 'inserted', charge: result.charge };
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export function queryUsage(ctx: ServiceContext, query: UsageQuery) {
  return listObservations(ctx.db, query);
}

export function queryCharges(
  ctx: ServiceContext,
  options: { accountId?: string; limit?: number; workspace?: WorkspaceScope } = {},
): Charge[] {
  return listCharges(ctx.db, options);
}

export interface UsageTotals {
  tokenValue: number | null;
  partial: boolean;
  knownCount: number;
  unknownCount: number;
  coverage: string;
  byModel: Array<{ model: string | null; value: number | null; count: number }>;
  byProject: Array<{ projectId: string | null; value: number | null; count: number }>;
  byClient: Array<{ clientId: string | null; value: number | null; count: number }>;
  suspectCount: number;
}

/**
 * 已观测 token 的汇总。
 *
 * 这里返回的是「已观测」而不是「总消耗」：覆盖范围由 `coverage` 文案说明，
 * 界面不允许只显示一个数字（§4.1）。
 */
export function usageTotals(ctx: ServiceContext, workspace: WorkspaceScope = 'real'): UsageTotals {
  const rows = countedObservations(ctx.db, workspace);
  const items = rows.map((r) => ({
    tokens: {
      inputTotal: r.inputTotal,
      outputTotal: r.outputTotal,
      totalReported: r.totalReported,
      cachedInput: r.cachedInput,
      reasoningOutput: r.reasoningOutput,
      cacheWriteInput: r.cacheWriteInput,
      basis: r.normalizationBasis,
      warnings: [],
    },
    value: r.totalReported,
  }));

  const agg = aggregateTokens(items);

  const group = <K extends string | null>(
    key: (row: UsageObservation) => K,
  ): Array<{ key: K; value: number | null; count: number }> => {
    const map = new Map<K, UsageObservation[]>();
    for (const row of rows) {
      const k = key(row);
      const list = map.get(k) ?? [];
      list.push(row);
      map.set(k, list);
    }
    return [...map.entries()].map(([k, list]) => ({
      key: k,
      value: aggregateTokens(
        list.map((r) => ({
          tokens: {
            inputTotal: r.inputTotal,
            outputTotal: r.outputTotal,
            totalReported: r.totalReported,
            cachedInput: r.cachedInput,
            reasoningOutput: r.reasoningOutput,
            cacheWriteInput: r.cacheWriteInput,
            basis: r.normalizationBasis,
            warnings: [],
          },
          value: r.totalReported,
        })),
      ).value,
      count: list.length,
    }));
  };

  return {
    tokenValue: agg.value,
    partial: agg.partial,
    knownCount: agg.knownCount,
    unknownCount: agg.unknownCount,
    coverage:
      agg.value === null && agg.skippedByBasis > 0
        ? `存在多种归一化依据，共 ${agg.skippedByBasis} 条未合并统计`
        : agg.value === null
          ? rows.length === 0
            ? '暂无已采集的用量记录'
            : `已有 ${rows.length} 条记录，但供应商均未报告 token`
          : `覆盖 ${agg.knownCount}/${rows.length} 条已采集记录${agg.unknownCount > 0 ? `，另有 ${agg.unknownCount} 条供应商未报告 token` : ''}`,
    byModel: group((r) => r.model).map((g) => ({ model: g.key, value: g.value, count: g.count })),
    byProject: group((r) => r.projectId).map((g) => ({ projectId: g.key, value: g.value, count: g.count })),
    byClient: group((r) => r.clientId).map((g) => ({ clientId: g.key, value: g.value, count: g.count })),
    suspectCount: countSuspectDuplicates(ctx.db, workspace),
  };
}

export function resolveDuplicateObservation(
  ctx: ServiceContext,
  id: string,
  decision: 'confirmed_unique' | 'confirmed_duplicate',
): UsageObservation {
  return tx(ctx.db, () => {
    const after = resolveDuplicate(ctx.db, id, decision, ctx.actor);
    if (!after) throw new TxAbort('not_found', `用量记录不存在：${id}`);
    audit(ctx, {
      action: 'usage.resolve_duplicate',
      entityType: 'usage_observation',
      entityId: id,
      detail: {
        decision,
        nowCounted: after.isPrimary,
        duplicateStatus: after.duplicateStatus,
      },
    });
    return after;
  });
}
