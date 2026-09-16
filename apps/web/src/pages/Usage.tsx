import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  api,
  type AccountRecord,
  type Charge,
  type ClientRecord,
  type ImportOutcome,
  type ProjectRecord,
  type QuotaBucket,
  type UsageObservation,
  type UsageTotals,
} from '../api.js';
import type { PageProps } from '../App.js';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  Modal,
  SourceLine,
  Unknown,
  formatDateTime,
  formatMoneyMinor,
  formatRelative,
  formatTokens,
  methodLabel,
  qualityLabel,
  qualityTone,
} from '../ui.js';

/**
 * 用量与订阅页。
 *
 * 三条界面纪律：
 * 1. 默认只列出**主统计源**。「证据行」和「待确认行」需要显式打开开关才看得到。
 * 2. 每行都能点开「这个数字怎么来的」——采集方式、数值质量、归一化依据、原始字段。
 * 3. 导入之前先预检。预检结果里「重放了多少行」比「成功了多少行」更重要，
 *    因为它决定你会不会因为重复导入而把账算成两倍。
 */

const KIND_FILTERS = [
  { key: '', label: '全部' },
  { key: 'event', label: '请求明细' },
  { key: 'summary', label: '账户汇总' },
] as const;

export function UsagePage({ toast, refreshToken, reload }: PageProps): ReactNode {
  const [tab, setTab] = useState<'usage' | 'charges' | 'quota' | 'import'>('usage');
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);

  const [observations, setObservations] = useState<UsageObservation[]>([]);
  const [total, setTotal] = useState(0);
  const [totals, setTotals] = useState<UsageTotals | null>(null);
  const [includeNonPrimary, setIncludeNonPrimary] = useState(false);
  const [filterKind, setFilterKind] = useState<string>('');
  const [filterAccount, setFilterAccount] = useState<string>('');
  const [filterProject, setFilterProject] = useState<string>('');
  const [filterClient, setFilterClient] = useState<string>('');
  const [filterQuality, setFilterQuality] = useState<string>('');
  const [detail, setDetail] = useState<UsageObservation | null>(null);

  const [charges, setCharges] = useState<Charge[]>([]);
  const [quotaBuckets, setQuotaBuckets] = useState<QuotaBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRegistry = useCallback(async () => {
    const [a, c, p] = await Promise.all([
      api.get<{ accounts: AccountRecord[] }>('/api/accounts'),
      api.get<{ clients: ClientRecord[] }>('/api/clients'),
      api.get<{ projects: ProjectRecord[] }>('/api/projects'),
    ]);
    setAccounts(a.accounts);
    setClients(c.clients);
    setProjects(p.projects);
  }, []);

  const loadUsage = useCallback(async () => {
    const params = new URLSearchParams();
    if (filterKind) params.set('kind', filterKind);
    if (filterAccount) params.set('accountId', filterAccount);
    if (filterProject) params.set('projectId', filterProject);
    if (filterClient) params.set('clientId', filterClient);
    if (filterQuality) params.set('measurementQuality', filterQuality);
    if (includeNonPrimary) params.set('includeNonPrimary', 'true');
    params.set('limit', '200');

    const result = await api.get<{ items: UsageObservation[]; total: number; totals: UsageTotals }>(
      `/api/usage?${params.toString()}`,
    );
    setObservations(result.items);
    setTotal(result.total);
    setTotals(result.totals);
  }, [filterKind, filterAccount, filterProject, filterClient, filterQuality, includeNonPrimary]);

  const loadCharges = useCallback(async () => {
    const result = await api.get<{ charges: Charge[] }>('/api/charges');
    setCharges(result.charges);
  }, []);

  const loadQuota = useCallback(async () => {
    const result = await api.get<{ groups: Array<{ buckets: QuotaBucket[] }> }>('/api/quota');
    setQuotaBuckets(result.groups.flatMap((g) => g.buckets));
  }, []);

  const reloadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([loadRegistry(), loadUsage(), loadCharges(), loadQuota()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [loadRegistry, loadUsage, loadCharges, loadQuota]);

  useEffect(() => {
    void reloadAll();
  }, [reloadAll, refreshToken]);

  const accountName = useMemo(() => new Map(accounts.map((a) => [a.id, a.alias])), [accounts]);
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.title])), [projects]);
  const clientName = useMemo(() => new Map(clients.map((c) => [c.id, c.displayName])), [clients]);

  if (error) return <Alert tone="danger" title="加载失败">{error}</Alert>;

  return (
    <div className="stack">
      <div className="pill-group">
        {(
          [
            ['usage', '用量明细'],
            ['charges', '收费流水'],
            ['quota', '额度快照'],
            ['import', '导入数据'],
          ] as const
        ).map(([key, label]) => (
          <button key={key} className={`tag-btn${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'usage' ? (
        <>
          <Card
            title="已观测 token"
            hint="只统计主统计源；未知不当作 0"
            actions={
              <a className="ghost small" href="/api/exports/usage.csv">
                导出 CSV（含公式注入防护）
              </a>
            }
          >
            <div className="row" style={{ gap: 26, alignItems: 'flex-start' }}>
              <div>
                <div className="metric-label">合计</div>
                <div className="metric-value small">
                  {totals ? formatTokens(totals.tokenValue) : <Unknown />}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div className="metric-label">覆盖范围</div>
                <div className="small-text">{totals?.coverage ?? '—'}</div>
                {totals && totals.unknownCount > 0 ? (
                  <div className="notice warn-text">
                    有 {totals.unknownCount} 条记录供应商未报告 token。它们没有被按 0 计入。
                  </div>
                ) : null}
              </div>
            </div>
            {totals && totals.byModel.length > 0 ? (
              <>
                <div className="sep" />
                <div className="metric-label">按模型</div>
                <div className="table-wrap" style={{ marginTop: 6 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>模型</th>
                        <th className="num">已观测 token</th>
                        <th className="num">记录数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {totals.byModel
                        .slice()
                        .sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
                        .map((row) => (
                          <tr key={row.model ?? '(未标注)'}>
                            <td>{row.model ?? <span className="faint">未标注</span>}</td>
                            <td className="num">{formatTokens(row.value)}</td>
                            <td className="num">{row.count}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
          </Card>

          <Card title="筛选" tight>
            <div className="row" style={{ gap: 12 }}>
              <div className="pill-group">
                {KIND_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    className={`tag-btn${filterKind === f.key ? ' active' : ''}`}
                    onClick={() => setFilterKind(f.key)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <select value={filterAccount} onChange={(e) => setFilterAccount(e.target.value)} style={{ width: 'auto' }}>
                <option value="">全部账户</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.alias}
                  </option>
                ))}
              </select>
              <select value={filterProject} onChange={(e) => setFilterProject(e.target.value)} style={{ width: 'auto' }}>
                <option value="">全部项目</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
              <select value={filterClient} onChange={(e) => setFilterClient(e.target.value)} style={{ width: 'auto' }}>
                <option value="">全部客户端</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
              <select value={filterQuality} onChange={(e) => setFilterQuality(e.target.value)} style={{ width: 'auto' }}>
                <option value="">全部可信度</option>
                <option value="provider_reported">供应商自报</option>
                <option value="locally_observed">本机可观测</option>
                <option value="estimated">估算</option>
                <option value="unknown">未知</option>
              </select>
              <label className="checkline">
                <input
                  type="checkbox"
                  checked={includeNonPrimary}
                  onChange={(e) => setIncludeNonPrimary(e.target.checked)}
                />
                <span>包含证据行与待确认行（不计入统计）</span>
              </label>
            </div>
          </Card>

          <Card title={`记录（${total} 条）`} hint={includeNonPrimary ? '包含非主统计源' : '仅主统计源'}>
            {loading && observations.length === 0 ? (
              <div className="faint">加载中…</div>
            ) : observations.length === 0 ? (
              <EmptyState kind="connected_no_data" title="当前筛选条件下没有记录">
                <span>换个筛选条件，或者到「导入数据」标签页粘贴一份 CSV / JSON。</span>
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>模型 / 归属</th>
                      <th className="num">输入</th>
                      <th className="num">输出</th>
                      <th className="num">缓存</th>
                      <th className="num">推理</th>
                      <th className="num">总量</th>
                      <th>来源</th>
                      <th>状态</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {observations.map((row) => (
                      <tr key={row.id} className={row.isPrimary ? '' : 'non-primary'}>
                        <td className="nowrap tiny">
                          {row.occurredAt ? formatDateTime(row.occurredAt) : <Unknown reason="时间字段缺失或无法解析" />}
                        </td>
                        <td>
                          <div>{row.model ?? <span className="faint">未标注模型</span>}</div>
                          <div className="faint tiny">
                            {[
                              row.projectId ? (projectName.get(row.projectId) ?? row.projectId) : null,
                              row.clientId ? (clientName.get(row.clientId) ?? row.clientId) : null,
                            ]
                              .filter(Boolean)
                              .join(' · ') || '未归属项目'}
                          </div>
                        </td>
                        <td className="num">{formatTokens(row.inputTotal)}</td>
                        <td className="num">{formatTokens(row.outputTotal)}</td>
                        <td className="num faint">{formatTokens(row.cachedInput)}</td>
                        <td className="num faint">{formatTokens(row.reasoningOutput)}</td>
                        <td className="num">
                          <strong>{formatTokens(row.totalReported)}</strong>
                        </td>
                        <td className="tiny">
                          <Badge tone={qualityTone(row.measurementQuality)}>{qualityLabel(row.measurementQuality)}</Badge>
                          <div className="faint tiny">{methodLabel(row.collectionMethod)}</div>
                        </td>
                        <td className="tiny">
                          {row.duplicateStatus === 'suspect' ? (
                            <Badge tone="warn">待确认重复</Badge>
                          ) : row.duplicateStatus === 'merged_evidence' ? (
                            <Badge tone="ghost">同一请求的其他来源</Badge>
                          ) : (
                            <Badge tone="ok">计入统计</Badge>
                          )}
                        </td>
                        <td className="nowrap">
                          <button className="ghost small" onClick={() => setDetail(row)}>
                            来源
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : null}

      {tab === 'charges' ? (
        <ChargesPanel
          accounts={accounts}
          charges={charges}
          accountName={accountName}
          onChanged={async () => {
            await loadCharges();
            reload();
          }}
          toast={toast}
        />
      ) : null}

      {tab === 'quota' ? (
        <QuotaPanel
          accounts={accounts}
          buckets={quotaBuckets}
          accountName={accountName}
          onChanged={async () => {
            await loadQuota();
            reload();
          }}
          toast={toast}
        />
      ) : null}

      {tab === 'import' ? (
        <ImportPanel
          accounts={accounts}
          projects={projects}
          clients={clients}
          onImported={async () => {
            await loadUsage();
            reload();
          }}
          toast={toast}
        />
      ) : null}

      {detail ? (
        <ObservationDetail
          observation={detail}
          accountName={accountName}
          projectName={projectName}
          clientName={clientName}
          onClose={() => setDetail(null)}
          onResolved={async () => {
            setDetail(null);
            await loadUsage();
            reload();
          }}
          toast={toast}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 用量详情                                                            */
/* ------------------------------------------------------------------ */

function ObservationDetail({
  observation,
  accountName,
  projectName,
  clientName,
  onClose,
  onResolved,
  toast,
}: {
  observation: UsageObservation;
  accountName: Map<string, string>;
  projectName: Map<string, string>;
  clientName: Map<string, string>;
  onClose: () => void;
  onResolved: () => Promise<void>;
  toast: PageProps['toast'];
}): ReactNode {
  const [busy, setBusy] = useState(false);

  const resolve = async (decision: 'confirmed_unique' | 'confirmed_duplicate'): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.post<{ note: string }>(`/api/usage/${observation.id}/resolve-duplicate`, { decision });
      toast(result.note, 'ok');
      await onResolved();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="这个数字怎么来的"
      subtitle="采集方式与数值质量是两件不同的事：方式说明「怎么拿到的」，质量说明「这个数有多可信」。"
      onClose={onClose}
      wide
    >
      <div className="stack">
        <div className="kv">
          <dt>记录 ID</dt>
          <dd className="mono">{observation.id}</dd>
          <dt>种类</dt>
          <dd>{observation.kind === 'summary' ? '账户汇总（有周期）' : '请求明细'}</dd>
          <dt>采集方式</dt>
          <dd>{methodLabel(observation.collectionMethod)}</dd>
          <dt>数值质量</dt>
          <dd>
            <Badge tone={qualityTone(observation.measurementQuality)}>
              {qualityLabel(observation.measurementQuality)}
            </Badge>
          </dd>
          <dt>归一化依据</dt>
          <dd className="mono">{observation.normalizationBasis}</dd>
          <dt>覆盖范围</dt>
          <dd>{observation.coverageScope ?? <Unknown reason="未声明覆盖范围" />}</dd>
          <dt>账户</dt>
          <dd>{observation.accountId ? (accountName.get(observation.accountId) ?? observation.accountId) : <Unknown />}</dd>
          <dt>项目</dt>
          <dd>{observation.projectId ? (projectName.get(observation.projectId) ?? observation.projectId) : '未归属'}</dd>
          <dt>客户端</dt>
          <dd>{observation.clientId ? (clientName.get(observation.clientId) ?? observation.clientId) : <Unknown />}</dd>
          <dt>请求 ID</dt>
          <dd className="mono">{observation.providerRequestId ?? <Unknown reason="供应商没有提供稳定的请求 ID" />}</dd>
          <dt>身份判定依据</dt>
          <dd>
            {observation.identityConfidence === 'stable_id'
              ? '稳定请求 ID'
              : observation.identityConfidence === 'content_fingerprint'
                ? '内容指纹（弱依据）'
                : '无可用依据'}
          </dd>
          <dt>观测时间</dt>
          <dd>{formatDateTime(observation.observedAt)}</dd>
        </div>

        <div className="sep" />

        <div>
          <h4>token 归一化</h4>
          <div className="notice">
            子集语义：cached ⊆ input，reasoning ⊆ output，因此总量 = 输入 + 输出。
            {observation.totalReported !== null && observation.inputTotal !== null && observation.outputTotal !== null ? (
              <>
                {' '}
                本次：{observation.inputTotal} + {observation.outputTotal} ={' '}
                <strong>{observation.totalReported}</strong>
                {observation.cachedInput !== null || observation.reasoningOutput !== null
                  ? `，缓存 ${observation.cachedInput ?? 0} 与推理 ${observation.reasoningOutput ?? 0} 是子项，不重复相加。`
                  : '。'}
              </>
            ) : null}
          </div>
          {observation.normalizationNotes.length > 0 ? (
            <ul className="list-plain">
              {observation.normalizationNotes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : null}
        </div>

        <div>
          <h4>原始字段（raw_usage，原样保留）</h4>
          <pre className="mono" style={{ background: 'var(--surface-2)', padding: 10, borderRadius: 6, overflow: 'auto' }}>
            {JSON.stringify(observation.rawUsage, null, 2)}
          </pre>
          <div className="notice">
            未识别的列不会被猜测含义，原始值一律保存在这里。所以即使某天我们加了新的适配器，
            这份数据依然可以重新解析。
          </div>
        </div>

        {observation.duplicateStatus === 'suspect' ? (
          <>
            <div className="sep" />
            <Alert tone="warn" title="这条记录疑似重复，当前没有计入统计">
              <span>
                它缺少稳定请求 ID，但内容与另一条记录完全相同。系统既没有把它合并掉（那可能吞掉一次真实请求），
                也没有把它计进去（那可能把一次请求算成两次）。
              </span>
              <span className="alert-hint">请对照原始来源确认它到底是几次，然后再做决定。</span>
              <div className="row tight" style={{ marginTop: 8 }}>
                <button className="primary small" disabled={busy} onClick={() => void resolve('confirmed_unique')}>
                  这是两次真实请求，计入统计
                </button>
                <button className="small" disabled={busy} onClick={() => void resolve('confirmed_duplicate')}>
                  这是同一次请求，保持不计入
                </button>
              </div>
            </Alert>
            {observation.duplicateOf ? (
              <div className="notice mono">参考记录：{observation.duplicateOf}</div>
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* 收费流水                                                            */
/* ------------------------------------------------------------------ */

function ChargesPanel({
  accounts,
  charges,
  accountName,
  onChanged,
  toast,
}: {
  accounts: AccountRecord[];
  charges: Charge[];
  accountName: Map<string, string>;
  onChanged: () => Promise<void>;
  toast: PageProps['toast'];
}): ReactNode {
  const [form, setForm] = useState({
    accountId: '',
    kind: 'api',
    amount: '',
    currency: 'CNY',
    status: 'paid',
    periodStart: '',
    billingRef: '',
    note: '',
  });
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!form.amount.trim()) {
      toast('请填写金额', 'warn');
      return;
    }
    setBusy(true);
    try {
      const money = parseDecimalToMinor(form.amount.trim(), form.currency);
      const result = await api.post<{ inserted: boolean; reason?: string }>('/api/charges', {
        accountId: form.accountId || null,
        kind: form.kind,
        amountMinor: money,
        currency: form.currency,
        status: form.status,
        periodStart: form.periodStart || null,
        billingRef: form.billingRef.trim() || null,
        note: form.note.trim() || null,
      });
      toast(
        result.inserted ? '已登记。' : `没有重复记账：${result.reason ?? ''}`,
        result.inserted ? 'ok' : 'warn',
      );
      setForm({ ...form, amount: '', billingRef: '', note: '' });
      await onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Card title="登记一笔收费" hint="钱和 token 是两种量纲，分开记">
        <div className="grid cols-3">
          <label className="field">
            <span>账户</span>
            <select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
              <option value="">不指定</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.alias}（{a.currency}）
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>类型</span>
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="subscription">订阅费</option>
              <option value="api">按量费用</option>
              <option value="extra">额外收费</option>
              <option value="refund">退款</option>
            </select>
          </label>
          <label className="field">
            <span>状态</span>
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="paid">已支付</option>
              <option value="pending">待结算</option>
              <option value="refunded">已退款</option>
              <option value="void">已作废</option>
            </select>
          </label>
          <label className="field">
            <span>金额</span>
            <input
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              placeholder="例如 19.99"
              inputMode="decimal"
            />
            <span className="help">按十进制定点存储，不经过浮点。</span>
          </label>
          <label className="field">
            <span>币种</span>
            <input
              value={form.currency}
              onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
              maxLength={3}
            />
            <span className="help">RMB 会被归一成 CNY，避免同一笔钱落在两个汇总桶里。</span>
          </label>
          <label className="field">
            <span>账期开始</span>
            <input
              type="date"
              value={form.periodStart}
              onChange={(e) => setForm({ ...form, periodStart: e.target.value })}
            />
            <span className="help">订阅类必填：同一订阅同一周期只记一次。</span>
          </label>
          <label className="field">
            <span>账单号</span>
            <input
              value={form.billingRef}
              onChange={(e) => setForm({ ...form, billingRef: e.target.value })}
              placeholder="invoice id"
            />
            <span className="help">有账单号时，同一账单不会被重复记账。</span>
          </label>
          <label className="field" style={{ gridColumn: 'span 2' }}>
            <span>备注</span>
            <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </label>
        </div>
        <div className="modal-foot" style={{ border: 'none', paddingTop: 8 }}>
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            登记
          </button>
        </div>
      </Card>

      <Card title={`收费记录（${charges.length} 笔）`} hint="按币种分行，不做跨币种相加">
        {charges.length === 0 ? (
          <EmptyState kind="connected_no_data" title="还没有登记任何收费记录" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>账户</th>
                  <th>类型</th>
                  <th className="num">金额</th>
                  <th>状态</th>
                  <th>账期 / 账单号</th>
                  <th>来源</th>
                </tr>
              </thead>
              <tbody>
                {charges.map((c) => (
                  <tr key={c.id}>
                    <td className="nowrap tiny">{formatDateTime(c.paidAt)}</td>
                    <td>{c.accountId ? (accountName.get(c.accountId) ?? c.accountId) : <span className="faint">未指定</span>}</td>
                    <td>{c.kind}</td>
                    <td className="num">
                      <strong>{formatMoneyMinor(c.amountMinor, c.currency)}</strong>
                    </td>
                    <td>
                      <Badge tone={c.status === 'paid' ? 'ok' : c.status === 'pending' ? 'warn' : 'neutral'}>{c.status}</Badge>
                    </td>
                    <td className="tiny">
                      {c.periodStart ?? '—'}
                      {c.billingRef ? <div className="faint mono">{c.billingRef}</div> : null}
                    </td>
                    <td>
                      <SourceLine method={c.collectionMethod} quality={c.measurementQuality} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 额度快照                                                            */
/* ------------------------------------------------------------------ */

function QuotaPanel({
  accounts,
  buckets,
  accountName,
  onChanged,
  toast,
}: {
  accounts: AccountRecord[];
  buckets: QuotaBucket[];
  accountName: Map<string, string>;
  onChanged: () => Promise<void>;
  toast: PageProps['toast'];
}): ReactNode {
  const [form, setForm] = useState({
    accountId: '',
    bucketId: '',
    bucketLabel: '',
    windowKind: 'hourly',
    scope: '',
    remainingPercent: '',
    usedPercent: '',
    resetAt: '',
    sourceRef: '',
    staleAfterSeconds: '21600',
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!form.accountId && accounts.length > 0) setForm((f) => ({ ...f, accountId: accounts[0]?.id ?? '' }));
  }, [accounts, form.accountId]);

  const submit = async (): Promise<void> => {
    if (!form.accountId) return toast('请先选择账户', 'warn');
    if (!form.bucketId.trim() || !form.bucketLabel.trim()) return toast('请填写额度桶 ID 与名称', 'warn');

    const used = form.usedPercent.trim() ? Number(form.usedPercent) / 100 : null;
    const remaining = form.remainingPercent.trim() ? Number(form.remainingPercent) / 100 : null;
    if (used !== null && (!Number.isFinite(used) || used < 0 || used > 1)) return toast('已用比例需在 0–100 之间', 'warn');
    if (remaining !== null && (!Number.isFinite(remaining) || remaining < 0 || remaining > 1))
      return toast('剩余比例需在 0–100 之间', 'warn');

    setBusy(true);
    try {
      await api.post('/api/quota-snapshots', {
        accountId: form.accountId,
        bucketId: form.bucketId.trim(),
        bucketLabel: form.bucketLabel.trim(),
        scope: form.scope.trim() || null,
        windowKind: form.windowKind,
        usedRatio: used,
        remainingRatio: remaining,
        resetAt: form.resetAt ? new Date(form.resetAt).toISOString() : null,
        observedAt: new Date().toISOString(),
        measurementQuality: 'provider_reported',
        collectionMethod: 'manual',
        sourceRef: form.sourceRef.trim() || null,
        staleAfterSeconds: Number(form.staleAfterSeconds) || 21600,
      });
      toast('额度快照已登记。', 'ok');
      setForm({ ...form, bucketId: '', bucketLabel: '', remainingPercent: '', usedPercent: '' });
      await onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Alert tone="info" title="额度是状态，不是流水">
        <span>
          快照不参与任何求和，也不会和账户汇总、请求明细相加。小时窗和周窗分别展示，
          不会平均成一个「综合剩余百分比」。
        </span>
        <span className="alert-hint">
          手动填「官网显示 60%」时，数值质量仍然是「供应商自报」，但采集方式是「手动录入」——
          两者的区别会诚实地标出来。
        </span>
      </Alert>

      <Card title="更新额度快照">
        <div className="grid cols-3">
          <label className="field">
            <span>账户</span>
            <select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
              <option value="">请选择</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.alias}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>额度桶 ID</span>
            <input
              value={form.bucketId}
              onChange={(e) => setForm({ ...form, bucketId: e.target.value })}
              placeholder="例如 chatgpt-weekly"
            />
            <span className="help">同一个桶的历史快照会串成一条时间线。</span>
          </label>
          <label className="field">
            <span>显示名称</span>
            <input value={form.bucketLabel} onChange={(e) => setForm({ ...form, bucketLabel: e.target.value })} />
          </label>
          <label className="field">
            <span>窗口</span>
            <select value={form.windowKind} onChange={(e) => setForm({ ...form, windowKind: e.target.value })}>
              <option value="hourly">小时窗</option>
              <option value="daily">日窗</option>
              <option value="weekly">周窗</option>
              <option value="monthly">月窗</option>
              <option value="custom">自定义</option>
            </select>
          </label>
          <label className="field">
            <span>已用 %</span>
            <input
              value={form.usedPercent}
              onChange={(e) => setForm({ ...form, usedPercent: e.target.value })}
              placeholder="42"
              inputMode="decimal"
            />
          </label>
          <label className="field">
            <span>剩余 %</span>
            <input
              value={form.remainingPercent}
              onChange={(e) => setForm({ ...form, remainingPercent: e.target.value })}
              placeholder="58"
              inputMode="decimal"
            />
            <span className="help">两者都填时之和必须为 100，否则会被标为自相矛盾。</span>
          </label>
          <label className="field">
            <span>重置时间</span>
            <input type="datetime-local" value={form.resetAt} onChange={(e) => setForm({ ...form, resetAt: e.target.value })} />
            <span className="help">到点但没重新查询时显示「待刷新」，不会自动按 100% 算。</span>
          </label>
          <label className="field">
            <span>共享入口</span>
            <input
              value={form.scope}
              onChange={(e) => setForm({ ...form, scope: e.target.value })}
              placeholder="ChatGPT App, Codex"
            />
          </label>
          <label className="field">
            <span>来源说明</span>
            <input
              value={form.sourceRef}
              onChange={(e) => setForm({ ...form, sourceRef: e.target.value })}
              placeholder="例如「官方设置页截图抄录」"
            />
          </label>
          <label className="field">
            <span>新鲜度阈值（秒）</span>
            <input
              value={form.staleAfterSeconds}
              onChange={(e) => setForm({ ...form, staleAfterSeconds: e.target.value })}
              inputMode="numeric"
            />
            <span className="help">超过这个时长没有新观测就显示「已过期快照」。</span>
          </label>
        </div>
        <div className="modal-foot" style={{ border: 'none', paddingTop: 8 }}>
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            保存快照
          </button>
        </div>
      </Card>

      <Card title={`现有额度桶（${buckets.length} 个）`}>
        {buckets.length === 0 ? (
          <EmptyState kind="not_configured" title="还没有登记过额度" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>账户 / 桶</th>
                  <th>窗口</th>
                  <th>状态</th>
                  <th>比例</th>
                  <th>重置</th>
                  <th>上次观测</th>
                  <th>共享入口</th>
                </tr>
              </thead>
              <tbody>
                {buckets.map((b) => (
                  <tr key={b.snapshotId}>
                    <td>
                      <div>{accountName.get(b.accountId) ?? b.accountId}</div>
                      <div className="faint tiny">{b.bucketLabel}</div>
                    </td>
                    <td>
                      <Badge tone="ghost">{b.windowKind}</Badge>
                    </td>
                    <td>
                      <div className="row tight">
                        <Badge
                          tone={
                            b.freshness === 'fresh' ? 'ok' : b.freshness === 'pending_refresh' ? 'warn' : b.freshness === 'stale' ? 'warn' : 'neutral'
                          }
                        >
                          {b.stateLabel}
                        </Badge>
                      </div>
                      {b.inconsistent ? <div className="danger-text tiny">数值自相矛盾</div> : null}
                    </td>
                    <td className="tiny">
                      {b.remainingRatio !== null ? `剩余 ${(b.remainingRatio * 100).toFixed(1)}%` : null}
                      {b.usedRatio !== null ? <div className="faint">已用 {(b.usedRatio * 100).toFixed(1)}%</div> : null}
                      {!b.ratioAuthoritative ? <div className="warn-text">不可作为当前值</div> : null}
                    </td>
                    <td className="tiny">{formatDateTime(b.resetAt)}</td>
                    <td className="tiny">
                      {formatDateTime(b.observedAt)}
                      <div className="faint">{formatRelative(b.observedAt)}</div>
                    </td>
                    <td className="tiny">{b.sharedWith.join('、') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 导入                                                                */
/* ------------------------------------------------------------------ */

function ImportPanel({
  accounts,
  projects,
  clients,
  onImported,
  toast,
}: {
  accounts: AccountRecord[];
  projects: ProjectRecord[];
  clients: ClientRecord[];
  onImported: () => Promise<void>;
  toast: PageProps['toast'];
}): ReactNode {
  const [kind, setKind] = useState<'usage_csv' | 'usage_json' | 'charge_csv'>('usage_csv');
  const [fileName, setFileName] = useState('usage.csv');
  const [content, setContent] = useState('');
  const [accountId, setAccountId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [clientId, setClientId] = useState('');
  const [collectionMethod, setCollectionMethod] = useState('imported_file');
  const [measurementQuality, setMeasurementQuality] = useState('provider_reported');
  const [coverageScope, setCoverageScope] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const run = async (dryRun: boolean): Promise<void> => {
    if (!content.trim()) return toast('请先粘贴内容或选择文件', 'warn');
    setBusy(true);
    try {
      const result = await api.post<ImportOutcome>('/api/imports', {
        kind,
        fileName,
        content,
        accountId: accountId || null,
        projectId: projectId || null,
        clientId: clientId || null,
        collectionMethod,
        measurementQuality,
        coverageScope: coverageScope.trim() || null,
        dryRun,
      });
      setOutcome(result);
      if (!dryRun) {
        toast(`导入完成：新增 ${result.acceptedRows} 行，重放 ${result.replayedRows} 行。`, 'ok');
        await onImported();
      } else {
        toast('预检完成，没有写入任何数据。', 'info');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Alert tone="info" title="先预检，再导入">
        <span>
          预检不写库，但会告诉你「有多少行会被判为重复导入」。这一步比「成功了多少行」更值得看：
          它决定你会不会因为同一个文件导入两次而把账算成两倍。
        </span>
        <span className="alert-hint">
          本版本支持纯文本 CSV / JSON。压缩包、二进制文件和含脚本特征的内容会被直接拒绝，
          原始文件不会被修改。
        </span>
      </Alert>

      <Card title="导入来源">
        <div className="grid cols-3">
          <label className="field">
            <span>数据类型</span>
            <select
              value={kind}
              onChange={(e) => {
                const next = e.target.value as typeof kind;
                setKind(next);
                setFileName(next === 'usage_json' ? 'usage.json' : next === 'charge_csv' ? 'charges.csv' : 'usage.csv');
              }}
            >
              <option value="usage_csv">用量 CSV</option>
              <option value="usage_json">用量 JSON</option>
              <option value="charge_csv">收费 CSV</option>
            </select>
          </label>
          <label className="field">
            <span>文件名</span>
            <input value={fileName} onChange={(e) => setFileName(e.target.value)} />
            <span className="help">只接受纯文件名。同一个文件名 + 同一份内容 = 同一个批次。</span>
          </label>
          <label className="field">
            <span>选择本地文件</span>
            <input
              type="file"
              ref={fileInput}
              accept={kind === 'usage_json' ? '.json,text/plain' : '.csv,.tsv,.txt'}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setFileName(file.name);
                setContent(await file.text());
                toast(`已读取 ${file.name}`, 'info');
              }}
            />
          </label>
          <label className="field">
            <span>采集方式</span>
            <select value={collectionMethod} onChange={(e) => setCollectionMethod(e.target.value)}>
              <option value="imported_file">导入文件</option>
              <option value="local_log">本地日志</option>
              <option value="manual">手动</option>
              <option value="official_api">官方接口</option>
            </select>
            <span className="help">系统不替你猜来源。这个选择会跟着每条记录保存。</span>
          </label>
          <label className="field">
            <span>数值质量</span>
            <select value={measurementQuality} onChange={(e) => setMeasurementQuality(e.target.value)}>
              <option value="provider_reported">供应商自报</option>
              <option value="locally_observed">本机可观测</option>
              <option value="estimated">估算</option>
              <option value="unknown">未知</option>
            </select>
            <span className="help">
              「官网导出的 CSV」和「我自己拼出来的日志」可信度不同，这个差别只存在于你脑子里。
            </span>
          </label>
          <label className="field">
            <span>覆盖范围说明</span>
            <input
              value={coverageScope}
              onChange={(e) => setCoverageScope(e.target.value)}
              placeholder="例如「仅 codex 客户端」"
            />
            <span className="help">会显示在概览的覆盖范围里，避免被误读成账户全量。</span>
          </label>
          <label className="field">
            <span>归属账户</span>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">不指定</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.alias}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>归属项目</span>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">不指定</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>归属客户端</span>
            <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">不指定</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div style={{ marginTop: 12 }}>
          <label className="field">
            <span>内容</span>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={10}
              placeholder={
                kind === 'usage_json'
                  ? '[{"occurred_at":"2026-09-01T00:00:00Z","input_tokens":1000,"output_tokens":200,"cached_tokens":600}]'
                  : kind === 'charge_csv'
                    ? 'occurred_at,amount,currency,kind,status,billing_ref,period_start\n2026-09-01,19.99,CNY,subscription,paid,inv-001,2026-09-01'
                    : 'occurred_at,model,input_tokens,output_tokens,cached_tokens,reasoning_tokens,request_id\n2026-09-01T00:00:00Z,model-a,10000,2000,6000,1000,req-1'
              }
              spellCheck={false}
            />
          </label>
        </div>

        <div className="modal-foot" style={{ border: 'none', paddingTop: 8 }}>
          <button className="ghost" disabled={busy} onClick={() => void run(true)}>
            预检（不写库）
          </button>
          <button className="primary" disabled={busy} onClick={() => void run(false)}>
            {busy ? '处理中…' : '导入'}
          </button>
        </div>
      </Card>

      {outcome ? (
        <Card title={outcome.dryRun ? '预检结果' : '导入结果'} hint={outcome.note}>
          <div className="grid cols-3">
            <div className="metric">
              <span className="metric-label">总行数</span>
              <span className="metric-value small">{outcome.totalRows}</span>
            </div>
            <div className="metric">
              <span className="metric-label">新增</span>
              <span className="metric-value small">{outcome.acceptedRows}</span>
            </div>
            <div className="metric">
              <span className="metric-label">重放（同一文件重复导入）</span>
              <span className="metric-value small faint">{outcome.replayedRows}</span>
            </div>
            <div className="metric">
              <span className="metric-label">同一请求的其他来源</span>
              <span className="metric-value small">{outcome.evidenceRows}</span>
            </div>
            <div className="metric">
              <span className="metric-label">待确认重复</span>
              <span className="metric-value small warn-text">{outcome.suspectRows}</span>
            </div>
            <div className="metric">
              <span className="metric-label">拒绝</span>
              <span className="metric-value small danger-text">{outcome.rejectedRows}</span>
            </div>
          </div>

          {outcome.previousImport ? (
            <>
              <div className="sep" />
              <Alert tone="warn" title="这个文件此前已经导入过">
                <span>
                  上次导入于 {formatDateTime(outcome.previousImport.finishedAt)}，当时新增了{' '}
                  {outcome.previousImport.acceptedRows} 行。本次重复的行会被判为重放，不会让数字翻倍。
                </span>
              </Alert>
            </>
          ) : null}

          {outcome.warnings.length > 0 ? (
            <>
              <div className="sep" />
              <div className="card-title">告警</div>
              <ul className="list-plain">
                {outcome.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </>
          ) : null}

          {outcome.errors.length > 0 ? (
            <>
              <div className="sep" />
              <div className="card-title">被拒绝的行</div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th className="num">行号</th>
                      <th>原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outcome.errors.slice(0, 50).map((e, i) => (
                      <tr key={i}>
                        <td className="num">{e.row}</td>
                        <td>{e.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="notice">
                被拒绝的行不会中断整次导入：其他行照常入库，错误精确到行号，方便你回去核对原始文件。
              </div>
            </>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

/** 主单位小数字面量 → 最小单位整数字符串。拒绝浮点输入。 */
function parseDecimalToMinor(decimal: string, currency: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(decimal)) {
    throw new Error(`金额 ${JSON.stringify(decimal)} 不是合法的十进制数`);
  }
  const digits = ['JPY', 'KRW', 'VND'].includes(currency.toUpperCase()) ? 0 : 2;
  const negative = decimal.startsWith('-');
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [intPart = '0', fracRaw = ''] = unsigned.split('.');
  if (fracRaw.length > digits) {
    throw new Error(`${currency} 最多 ${digits} 位小数`);
  }
  const minor = BigInt(`${intPart}${fracRaw.padEnd(digits, '0')}`);
  return (negative ? -minor : minor).toString();
}
