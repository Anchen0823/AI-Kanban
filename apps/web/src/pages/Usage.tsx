import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  api,
  workspacePath,
  type AccountRecord,
  type ClientRecord,
  type ImportOutcome,
  type ProjectRecord,
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
  Unknown,
  formatDateTime,
  formatTokens,
  methodLabel,
  qualityLabel,
  qualityTone,
} from '../ui.js';

/**
 * 用量明细与导入页。
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
  const [tab, setTab] = useState<'usage' | 'import'>('usage');
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

  const reloadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([loadRegistry(), loadUsage()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [loadRegistry, loadUsage]);

  useEffect(() => {
    void reloadAll();
  }, [reloadAll, refreshToken]);

  const accountName = useMemo(() => new Map(accounts.map((a) => [a.id, a.alias])), [accounts]);
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.title])), [projects]);
  const clientName = useMemo(() => new Map(clients.map((c) => [c.id, c.displayName])), [clients]);

  if (error) return <Alert tone="danger" title="加载失败">{error}</Alert>;

  return (
    <div className="stack usage-page">
      <div className="page-tabs">
        {(
          [
            ['usage', '用量明细'],
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
            title="已导入用量"
            hint="仅统计导入记录，本机历史请在用量统计中查看"
            actions={
              <a className="ghost small" href={workspacePath('/api/exports/usage.csv')}>
                导出 CSV ↗
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
                    {totals.unknownCount} 条记录没有 token 数值，未按 0 计入。
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

          <div className="usage-filters" aria-label="筛选用量">
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
              <select aria-label="账户" value={filterAccount} onChange={(e) => setFilterAccount(e.target.value)} style={{ width: 'auto' }}>
                <option value="">全部账户</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.alias}
                  </option>
                ))}
              </select>
              <select aria-label="项目" value={filterProject} onChange={(e) => setFilterProject(e.target.value)} style={{ width: 'auto' }}>
                <option value="">全部项目</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
              <select aria-label="客户端" value={filterClient} onChange={(e) => setFilterClient(e.target.value)} style={{ width: 'auto' }}>
                <option value="">全部客户端</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
              <select aria-label="可信度" value={filterQuality} onChange={(e) => setFilterQuality(e.target.value)} style={{ width: 'auto' }}>
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
                <span>显示证据与待确认行</span>
              </label>
            </div>
          </div>

          <Card title={`记录（${total} 条）`} hint={includeNonPrimary ? '含证据与待确认行' : '仅主统计源'}>
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
                            详情
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
/* 用量导入                                                            */
/* ------------------------------------------------------------------ */

function importSummary(r: ImportOutcome): string {
  const parts: string[] = [`新增 ${r.acceptedRows} 行`];
  if (r.replayedRows > 0) parts.push(`完全一致跳过 ${r.replayedRows} 行`);
  if (r.evidenceRows > 0) parts.push(`重复来源留证 ${r.evidenceRows} 行`);
  if (r.suspectRows > 0) parts.push(`待确认 ${r.suspectRows} 行`);
  if (r.rejectedRows > 0) parts.push(`拒绝 ${r.rejectedRows} 行`);

  const summary = parts.join('，');
  if (r.acceptedRows > 0) return `导入完成：${summary}。`;

  const deduped = r.replayedRows + r.evidenceRows + r.suspectRows;
  if (deduped > 0) {
    return `没有新增数据：${summary}。这些内容此前已经入库，token 与金额不会翻倍。`;
  }
  return `导入没有产生任何记录：${summary}。`;
}

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
  const [kind, setKind] = useState<'usage_csv' | 'usage_json'>('usage_csv');
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
        toast(importSummary(result), result.acceptedRows > 0 ? 'ok' : 'warn');
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
      <Card title="导入来源">
        <div className="grid cols-3">
          <label className="field">
            <span>数据类型</span>
            <select
              value={kind}
              onChange={(e) => {
                const next = e.target.value as typeof kind;
                setKind(next);
                setFileName(next === 'usage_json' ? 'usage.json' : 'usage.csv');
              }}
            >
              <option value="usage_csv">用量 CSV</option>
              <option value="usage_json">用量 JSON</option>
            </select>
          </label>
          <label className="field">
            <span>文件名</span>
            <input value={fileName} onChange={(e) => setFileName(e.target.value)} />
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
          </label>
          <label className="field">
            <span>数值质量</span>
            <select value={measurementQuality} onChange={(e) => setMeasurementQuality(e.target.value)}>
              <option value="provider_reported">供应商自报</option>
              <option value="locally_observed">本机可观测</option>
              <option value="estimated">估算</option>
              <option value="unknown">未知</option>
            </select>
          </label>
          <label className="field">
            <span>覆盖范围说明</span>
            <input
              value={coverageScope}
              onChange={(e) => setCoverageScope(e.target.value)}
              placeholder="例如「仅 codex 客户端」"
            />
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
              <span className="metric-label">完全一致已跳过</span>
              <span className="metric-value small faint">{outcome.replayedRows}</span>
            </div>
            <div className="metric">
              <span className="metric-label">重复来源留证（不计入）</span>
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
                  {outcome.previousImport.acceptedRows} 行。重复的行<strong>不会让数字翻倍</strong>：
                  内容完全一致的直接跳过，命中同一 request_id 的留作证据但不计入统计。
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
