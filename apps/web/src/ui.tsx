/**
 * 共用界面组件。
 *
 * 其中 `<Unknown/>`、`<EmptyState/>` 与 `<SourceLine/>` 是本项目特有的：
 * 设计稿反复强调「未知不能用 0 冒充」「空状态要区分五种含义」「每个数字都要能点开看来源」，
 * 把这三件事做成组件，就不需要在每个页面里靠自觉去遵守。
 */

import { useEffect, useRef, type ReactNode } from 'react';

/* ------------------------------------------------------------------ */
/* 未知与空状态                                                        */
/* ------------------------------------------------------------------ */

export function Unknown({ reason }: { reason?: string }): ReactNode {
  return (
    <span className="unknown" title={reason ?? '供应商未报告该数值'}>
      未知
    </span>
  );
}

export type EmptyKind =
  /** 还没配置过相关的东西。 */
  | 'not_configured'
  /** 连接好了，但一条数据都还没采到。 */
  | 'connected_no_data'
  /** 当前不可用（功能没实现、接口不通）。 */
  | 'unavailable'
  /** 确实不知道。 */
  | 'unknown'
  /** 真实为零 —— 这是唯一可以显示 0 的情况。 */
  | 'real_zero';

const EMPTY_LABEL: Record<EmptyKind, string> = {
  not_configured: '未配置',
  connected_no_data: '已连接但未采集',
  unavailable: '当前不可用',
  unknown: '未知',
  real_zero: '真实为零',
};

export function EmptyState({
  kind,
  title,
  children,
}: {
  kind: EmptyKind;
  title: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="empty">
      <span className="empty-state">{EMPTY_LABEL[kind]}</span>
      <span className="empty-title">{title}</span>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 徽标                                                                */
/* ------------------------------------------------------------------ */

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'demo' | 'ghost';

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }): ReactNode {
  return (
    <span className={`badge ${tone}`} title={title}>
      {children}
    </span>
  );
}

/** demo 数据必须持续可见地标出来，不能和真实数据混在一起（INV-16）。 */
export function DemoBadge(): ReactNode {
  return <Badge tone="demo">示例数据</Badge>;
}

export function isDemoName(name: string): boolean {
  return name.includes('【示例】');
}

/* ------------------------------------------------------------------ */
/* 数据来源                                                            */
/* ------------------------------------------------------------------ */

const METHOD_LABEL: Record<string, string> = {
  official_api: '官方接口',
  local_log: '本地日志',
  imported_file: '导入文件',
  manual: '手动录入',
};

const QUALITY_LABEL: Record<string, string> = {
  provider_reported: '供应商自报',
  locally_observed: '本机可观测',
  estimated: '估算',
  unknown: '未知',
};

export const methodLabel = (v: string): string => METHOD_LABEL[v] ?? v;
export const qualityLabel = (v: string): string => QUALITY_LABEL[v] ?? v;

export function qualityTone(v: string): Tone {
  if (v === 'provider_reported') return 'ok';
  if (v === 'locally_observed') return 'accent';
  if (v === 'estimated') return 'warn';
  return 'neutral';
}

/**
 * 每个数值的出处。§4.1 要求「所有数据支持点开『这个数字怎么来的』」。
 * 这里做成内联的一行小字 + title，点击可展开。
 */
export function SourceLine({
  method,
  quality,
  observedAt,
  sourceRef,
  extra,
}: {
  method: string;
  quality: string;
  observedAt?: string | null;
  sourceRef?: string | null;
  extra?: ReactNode;
}): ReactNode {
  const parts = [methodLabel(method), qualityLabel(quality)];
  if (observedAt) parts.push(`观测于 ${formatDateTime(observedAt)}`);
  if (sourceRef) parts.push(sourceRef);
  return (
    <div className="notice row tight" style={{ gap: 8 }}>
      <span className="mono">{parts.join(' · ')}</span>
      {extra}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 弹层                                                                */
/* ------------------------------------------------------------------ */

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`modal${wide ? ' wide' : ''}`} ref={ref} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {subtitle ? <div className="sub muted tiny" style={{ marginTop: 3 }}>{subtitle}</div> : null}
          </div>
          <button className="ghost small" onClick={onClose} aria-label="关闭">
            关闭
          </button>
        </div>
        {children}
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 数据展示                                                            */
/* ------------------------------------------------------------------ */

export function Metric({
  label,
  value,
  note,
  small,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  small?: boolean;
}): ReactNode {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className={`metric-value${small ? ' small' : ''}`}>{value}</span>
      {note ? <span className="metric-note">{note}</span> : null}
    </div>
  );
}

export function Card({
  title,
  hint,
  actions,
  children,
  tight,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  tight?: boolean;
}): ReactNode {
  return (
    <section className={`card${tight ? ' tight' : ''}`}>
      {title || actions ? (
        <div className="card-head">
          <div>
            <div className="card-title">{title}</div>
            {hint ? <div className="card-hint">{hint}</div> : null}
          </div>
          {actions ? <div className="row tight">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'ok';
  title?: ReactNode;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className={`alert ${tone}`}>
      {title ? <span className="alert-title">{title}</span> : null}
      {children}
    </div>
  );
}

/** 次级口径说明默认收起，避免把主操作埋在长段落里。 */
export function Explain({ children }: { children: ReactNode }): ReactNode {
  return (
    <details className="explain">
      <summary>说明</summary>
      <div className="explain-body">{children}</div>
    </details>
  );
}

export function StateDot({ tone }: { tone: Tone }): ReactNode {
  const cls = tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'danger' ? 'danger' : tone === 'accent' ? 'accent' : 'neutral';
  return <span className={`dot ${cls}`} />;
}

/* ------------------------------------------------------------------ */
/* 格式化                                                              */
/* ------------------------------------------------------------------ */

export function formatTokens(value: number | null): ReactNode {
  if (value === null) return <Unknown />;
  return value.toLocaleString('zh-CN');
}

export function formatMoneyMinor(amountMinor: string, currency: string): string {
  const digits = ['JPY', 'KRW', 'VND', 'CLP', 'ISK'].includes(currency) ? 0 : 2;
  const negative = amountMinor.startsWith('-');
  const abs = (negative ? amountMinor.slice(1) : amountMinor).padStart(digits + 1, '0');
  const body = digits === 0 ? abs : `${abs.slice(0, abs.length - digits)}.${abs.slice(abs.length - digits)}`;
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency === 'JPY' ? '¥' : '';
  const grouped = body.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${symbol}${grouped}${symbol ? '' : ` ${currency}`}`;
}

export function formatMoneyBuckets(buckets: Array<{ currency: string; amountMinor: string; count: number }>): ReactNode {
  if (buckets.length === 0) return <Unknown reason="当前口径下没有任何记录" />;
  return (
    <div className="metric-list">
      {buckets.map((b) => (
        <div className="metric-line" key={b.currency}>
          <span className="k">{b.currency}</span>
          <span>
            {formatMoneyMinor(b.amountMinor, b.currency)} <span className="faint tiny">({b.count} 笔)</span>
          </span>
        </div>
      ))}
    </div>
  );
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '前' : '后';
  if (abs < 60_000) return '刚刚';
  if (abs < 3_600_000) return `${Math.floor(abs / 60_000)} 分钟${suffix}`;
  if (abs < 86_400_000) {
    const h = Math.floor(abs / 3_600_000);
    const m = Math.floor((abs % 3_600_000) / 60_000);
    return m > 0 ? `${h} 小时 ${m} 分钟${suffix}` : `${h} 小时${suffix}`;
  }
  const d = Math.floor(abs / 86_400_000);
  const h = Math.floor((abs % 86_400_000) / 3_600_000);
  return h > 0 ? `${d} 天 ${h} 小时${suffix}` : `${d} 天${suffix}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 复制到剪贴板，并给出明确的成功 / 失败反馈（失败时不能假装成功）。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 术语表                                                              */
/* ------------------------------------------------------------------ */

export const KIND_LABEL: Record<string, string> = {
  preference: '偏好',
  fact: '事实',
  decision: '决策',
  lesson: '经验 / 失败路径',
  hypothesis: '未验证猜想',
  handoff: '交接材料',
};

export const STATUS_LABEL: Record<string, string> = {
  active: '生效中',
  superseded: '已被替代',
  archived: '已归档',
  expired: '已过期',
  deleted: '已删除',
  pending: '待审核',
  approved: '已批准',
  rejected: '已驳回',
  conflict: '版本冲突',
};

export const VERIFICATION_LABEL: Record<string, string> = {
  unverified: '未验证',
  locally_tested: '本机测过',
  formally_verified: '形式化验证',
  human_confirmed: '人工确认',
};

export const CAPABILITY_LABEL: Record<string, string> = {
  documented: '仅有官方文档描述',
  verified: '本机已验证',
  unsupported: '不支持',
  unknown: '未知',
};

export function capabilityTone(status: string): Tone {
  if (status === 'verified') return 'ok';
  if (status === 'documented') return 'warn';
  if (status === 'unsupported') return 'danger';
  return 'neutral';
}

export function statusTone(status: string): Tone {
  if (status === 'active' || status === 'approved') return 'ok';
  if (status === 'pending') return 'accent';
  if (status === 'conflict') return 'danger';
  if (status === 'rejected' || status === 'deleted') return 'danger';
  return 'neutral';
}

export function freshnessTone(freshness: string): Tone {
  if (freshness === 'fresh') return 'ok';
  if (freshness === 'stale') return 'warn';
  if (freshness === 'pending_refresh') return 'warn';
  return 'neutral';
}

export function describeQuotaPercent(bucket: {
  remainingRatio: number | null;
  usedRatio: number | null;
  ratioAuthoritative: boolean;
}): string {
  if (!bucket.ratioAuthoritative) return '不可作为当前值展示';
  if (bucket.remainingRatio !== null) return `剩余 ${(bucket.remainingRatio * 100).toFixed(1)}%`;
  if (bucket.usedRatio !== null) return `已用 ${(bucket.usedRatio * 100).toFixed(1)}%`;
  return '未知';
}
