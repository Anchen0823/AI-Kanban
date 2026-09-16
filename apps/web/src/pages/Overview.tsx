import { useEffect, useState, type ReactNode } from 'react';
import { api, type Overview } from '../api.js';
import type { PageProps } from '../App.js';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  Metric,
  SourceLine,
  StateDot,
  Unknown,
  capabilityTone,
  CAPABILITY_LABEL,
  describeQuotaPercent,
  formatDateTime,
  formatMoneyBuckets,
  formatRelative,
  formatTokens,
  freshnessTone,
  qualityLabel,
  qualityTone,
} from '../ui.js';

/**
 * 概览页。
 *
 * 这一页最重要的事情是**不做什么**：它不给一个跨币种、跨口径的「总消耗」。
 * 各币种支出按状态分桶、token 只报「已观测」并附覆盖范围、额度是独立的状态卡片。
 * 用户想合并看，必须先自己做决定（或者去「用量与订阅」页按币种逐个看）。
 */

export function OverviewPage({ navigate, refreshToken }: PageProps): ReactNode {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showOrigin, setShowOrigin] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<Overview>('/api/overview')
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  if (loading && !data) return <div className="faint">加载中…</div>;
  if (error) return <Alert tone="danger" title="加载概览失败">{error}</Alert>;
  if (!data) return <EmptyState kind="unknown" title="没有拿到概览数据" />;

  const hasAnyData = data.counts.observations > 0 || data.counts.charges > 0 || data.memory.active > 0;

  return (
    <div className="stack">
      {data.attention.length > 0 ? (
        <div className="stack" style={{ gap: 8 }}>
          {data.attention.map((item, idx) => (
            <Alert key={idx} tone={item.level === 'warn' ? 'warn' : 'info'} title={item.text}>
              {item.hint ? <span className="alert-hint">{item.hint}</span> : null}
            </Alert>
          ))}
        </div>
      ) : null}

      {!hasAnyData ? (
        <EmptyState kind="connected_no_data" title="还没有任何真实数据">
          <span>
            可以先到「设置与连接」生成一份示例数据看看各页长什么样，或者直接开始登记账户与项目。
          </span>
        </EmptyState>
      ) : null}

      <div className="grid cols-3">
        <Card
          title="已观测 token"
          hint="不是「总消耗」"
          actions={
            <button className="ghost small" onClick={() => navigate('usage')}>
              看明细
            </button>
          }
        >
          <Metric
            label="已观测 token 合计"
            value={formatTokens(data.tokens.observed)}
            small={data.tokens.observed === null}
            note={
              <>
                {data.tokens.coverage}
                {data.tokens.partial ? <span className="warn-text"> · 部分记录供应商未报告</span> : null}
              </>
            }
          />
          <div className="sep" />
          <div className="notice">{data.disclaimers.tokens}</div>
          {data.tokens.observed === null && data.counts.observations > 0 ? (
            <div className="notice">
              注意：这里显示「未知」而不是 0。未知和「真实为零」是两件事，混起来会让月度对比完全失真。
            </div>
          ) : null}
        </Card>

        <Card title="待审核记忆" hint="未批准前不会进入任何上下文包">
          <Metric
            label="候选箱"
            value={data.memory.pendingProposals}
            note={`生效中 ${data.memory.active} · 已归档 ${data.memory.archived} · 已过期 ${data.memory.expired}`}
          />
          <div className="row tight" style={{ marginTop: 10 }}>
            <button className="small" onClick={() => navigate('memory')}>
              去审核
            </button>
          </div>
          <div className="sep" />
          <div className="notice">
            墓碑 {data.memory.tombstones} 条：已删除的记忆只留下哈希，防止旧导入包把它们复活。
          </div>
        </Card>

        <Card title="数据可信度分布" hint="每个数字的出处必须可追溯">
          <div className="metric-list">
            {data.usage.byQuality.length === 0 ? (
              <span className="faint tiny">暂无记录</span>
            ) : (
              data.usage.byQuality.map((q) => (
                <div className="metric-line" key={q.quality}>
                  <span className="k">
                    <Badge tone={qualityTone(q.quality)}>{qualityLabel(q.quality)}</Badge>
                  </span>
                  <span>{q.count} 条</span>
                </div>
              ))
            )}
          </div>
          <div className="sep" />
          <div className="metric-list">
            {data.usage.byCollectionMethod.map((m) => (
              <div className="metric-line" key={m.method}>
                <span className="k">{m.method}</span>
                <span>{m.count} 条</span>
              </div>
            ))}
          </div>
          {data.usage.suspectDuplicates > 0 ? (
            <>
              <div className="sep" />
              <Alert tone="warn" title={`${data.usage.suspectDuplicates} 条疑似重复待确认`}>
                <span className="alert-hint">
                  它们缺少稳定请求 ID 但内容与已有记录相同，既没有计入统计，也没有被删除。
                </span>
              </Alert>
            </>
          ) : null}
        </Card>
      </div>

      <Card
        title="支出（按币种、按状态分开）"
        hint="不做跨币种相加"
        actions={
          <button className="ghost small" onClick={() => navigate('usage')}>
            记账与对账
          </button>
        }
      >
        <div className="grid cols-3">
          <div>
            <div className="metric-label">实际已支付</div>
            {formatMoneyBuckets(data.charges.paid)}
          </div>
          <div>
            <div className="metric-label">已报告未结算</div>
            {formatMoneyBuckets(data.charges.pending)}
          </div>
          <div>
            <div className="metric-label">退款</div>
            {formatMoneyBuckets(data.charges.refunded)}
          </div>
        </div>
        {data.charges.estimated.length > 0 ? (
          <>
            <div className="sep" />
            <div className="row" style={{ alignItems: 'flex-start', gap: 18 }}>
              <div style={{ minWidth: 220 }}>
                <div className="metric-label">
                  <Badge tone="warn">估算费用</Badge>
                </div>
                {formatMoneyBuckets(data.charges.estimated)}
              </div>
              <div className="notice" style={{ flex: 1 }}>
                估算费用与实际支出<strong>永远分开展示</strong>，不会并进同一个数字。
                把它混进去会让「这个月花了多少」变成一句无法核对的话。
              </div>
            </div>
          </>
        ) : null}
        <div className="sep" />
        <ul className="list-plain">
          {data.charges.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </Card>

      <Card
        title="额度快照"
        hint="额度是状态，不是流水；不参与任何求和"
        actions={
          <button className="ghost small" onClick={() => navigate('usage')}>
            更新额度
          </button>
        }
      >
        {data.quota.groups.length === 0 ? (
          <EmptyState kind="not_configured" title="还没有登记过任何额度快照">
            <span>
              额度需要手动从官方页面抄录，或由 M1 的只读探测自动更新。当前版本只能手动。
            </span>
          </EmptyState>
        ) : (
          <div className="stack" style={{ gap: 12 }}>
            {data.quota.groups.map((group) => (
              <div key={group.windowKind}>
                <div className="row tight" style={{ marginBottom: 6 }}>
                  <Badge tone="ghost">{group.windowLabel}</Badge>
                  <span className="faint tiny">不同窗口不合并成「综合剩余百分比」</span>
                </div>
                <div className="grid cols-2">
                  {group.buckets.map((bucket) => (
                    <div className="card tight" key={bucket.snapshotId} style={{ boxShadow: 'none' }}>
                      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <div className="row tight">
                            <StateDot tone={freshnessTone(bucket.freshness)} />
                            <strong style={{ fontSize: 13 }}>{bucket.bucketLabel}</strong>
                          </div>
                          <div className="faint tiny">{bucket.accountId}</div>
                        </div>
                        <Badge tone={freshnessTone(bucket.freshness)}>{bucket.stateLabel}</Badge>
                      </div>
                      <div className="sep" />
                      <div className="kv">
                        <dt>剩余 / 已用</dt>
                        <dd>
                          {describeQuotaPercent(bucket)}
                          {bucket.remainingRatio !== null && bucket.usedRatio !== null ? (
                            <span className="faint tiny">
                              {' '}
                              （已用 {(bucket.usedRatio * 100).toFixed(1)}%）
                            </span>
                          ) : null}
                        </dd>
                        <dt>重置时间</dt>
                        <dd>{bucket.resetAt ? formatDateTime(bucket.resetAt) : <Unknown reason="没有提供重置时间" />}</dd>
                        <dt>上次观测</dt>
                        <dd>
                          {formatDateTime(bucket.observedAt)}{' '}
                          <span className="faint tiny">（{formatRelative(bucket.observedAt)}）</span>
                        </dd>
                        {bucket.sharedWith.length > 0 ? (
                          <>
                            <dt>共享入口</dt>
                            <dd>{bucket.sharedWith.join('、')}</dd>
                          </>
                        ) : null}
                      </div>
                      <div className="sep" />
                      <ul className="list-plain">
                        {bucket.reasons.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                      <SourceLine
                        method={bucket.collectionMethod}
                        quality={bucket.measurementQuality}
                        sourceRef={bucket.sourceRef}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid cols-2">
        <Card
          title="接入状态"
          hint="「官方文档说支持」与「本机已验证」是两种不同状态"
          actions={
            <button className="ghost small" onClick={() => navigate('settings')}>
              管理连接
            </button>
          }
        >
          <div className="stack" style={{ gap: 8 }}>
            {data.integrations.map((integration) => (
              <div key={integration.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div className="row tight">
                    <StateDot tone={capabilityTone(integration.capabilityStatus)} />
                    <strong style={{ fontSize: 12.5 }}>{integration.name}</strong>
                  </div>
                  {integration.notes ? <div className="faint tiny">{integration.notes}</div> : null}
                </div>
                <div style={{ textAlign: 'right', flex: 'none' }}>
                  <Badge tone={capabilityTone(integration.capabilityStatus)}>
                    {CAPABILITY_LABEL[integration.capabilityStatus] ?? integration.capabilityStatus}
                  </Badge>
                  <div className="faint tiny">
                    {integration.verifiedAt
                      ? `验证于 ${formatDateTime(integration.verifiedAt)}`
                      : '从未验证'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <div className="stack">
          <Card
            title="最近导入"
            hint="重复导入同一文件不会让数字翻倍"
            actions={
              <button className="ghost small" onClick={() => navigate('usage')}>
                导入数据
              </button>
            }
          >
            {data.recentImports.length === 0 ? (
              <EmptyState kind="connected_no_data" title="还没有导入过任何文件" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>文件</th>
                      <th className="num">新增</th>
                      <th className="num">重放</th>
                      <th className="num">待确认</th>
                      <th className="num">拒绝</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentImports.slice(0, 6).map((job) => (
                      <tr key={job.id}>
                        <td>
                          <div className="truncate" style={{ maxWidth: 220 }}>
                            {job.fileName}
                          </div>
                          <div className="faint tiny">
                            {job.kind} · {formatRelative(job.startedAt)}
                          </div>
                        </td>
                        <td className="num">{job.acceptedRows}</td>
                        <td className="num faint">{job.replayedRows}</td>
                        <td className="num warn-text">{job.suspectRows || ''}</td>
                        <td className="num danger-text">{job.rejectedRows || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="最近审计" hint="只记动作与 ID，不复制敏感全文">
            {data.recentAudit.length === 0 ? (
              <EmptyState kind="real_zero" title="还没有任何操作记录" />
            ) : (
              <div className="stack" style={{ gap: 5 }}>
                {data.recentAudit.map((event, i) => (
                  <div className="row" key={i} style={{ justifyContent: 'space-between', gap: 10 }}>
                    <span className="mono tiny truncate">{event.action}</span>
                    <span className="faint tiny nowrap">
                      {event.entityId ? `${event.entityId.slice(0, 14)}…` : event.entityType} ·{' '}
                      {formatRelative(event.at)}
                      {event.result !== 'ok' ? <span className="danger-text"> [{event.result}]</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <Card title="本机信息" hint="这些值直接来自运行中的服务，不是写死的文案">
        <div className="kv">
          <dt>数据工作区</dt>
          <dd>
            {data.workspace}
            <span className="faint tiny"> · 示例数据与真实数据分开展示，互不污染</span>
          </dd>
          <dt>SQLite 驱动</dt>
          <dd className="mono">{data.driver}</dd>
          <dt>数据目录</dt>
          <dd className="mono">{data.dataDir}</dd>
          <dt>生成时间</dt>
          <dd>{formatDateTime(data.generatedAt)}</dd>
        </div>
        <div className="sep" />
        <div className="row tight">
          <button className="ghost small" onClick={() => setShowOrigin(showOrigin ? null : 'origin')}>
            {showOrigin ? '收起口径说明' : '这些数字是怎么算出来的'}
          </button>
        </div>
        {showOrigin ? (
          <div className="stack" style={{ gap: 8, marginTop: 10 }}>
            {Object.entries(data.disclaimers).map(([key, text]) => (
              <div key={key} className="notice">
                <strong className="mono">{key}</strong>：{text}
              </div>
            ))}
            <div className="notice">
              统计只对「主统计源」求和：同一条真实请求只计一次，其他来源作为证据保留但不重复计入。
              缺少稳定请求 ID 的重复记录标为待确认，同样不计入，直到你确认它到底是一次还是两次。
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
