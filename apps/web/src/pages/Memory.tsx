import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { diffLines } from '@aicc/core';
import { api, type MemoryRecord, type ProjectRecord, type ProposalRecord } from '../api.js';
import type { PageProps } from '../App.js';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  KIND_LABEL,
  Modal,
  STATUS_LABEL,
  VERIFICATION_LABEL,
  formatDateTime,
  formatRelative,
  statusTone,
} from '../ui.js';

/**
 * 记忆中心。
 *
 * 这一页的布局本身就是在表达产品立场（§8）：
 * **来源在左、候选在右、变更差异在下。**
 *
 * 左右并排是为了让你能逐条对照「模型说的」和「系统里存的」；
 * 差异在下方是为了让「这次改动到底改了什么」不用靠肉眼比对两段文字。
 * 批准按钮放在最下面，而且左边永远是「驳回」——不对，是「驳回」在左、「批准」在右，
 * 但批准必须先看过差异才可用。
 */

export function MemoryPage({ toast, refreshToken, reload }: PageProps): ReactNode {
  const [tab, setTab] = useState<'proposals' | 'library'>('proposals');
  const [proposals, setProposals] = useState<ProposalRecord[]>([]);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [counters, setCounters] = useState<Record<string, number>>({});
  const [proposalStatus, setProposalStatus] = useState<'pending' | 'conflict' | 'approved' | 'rejected'>('pending');
  const [memoryQuery, setMemoryQuery] = useState('');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [openProposal, setOpenProposal] = useState<string | null>(null);
  const [openMemory, setOpenMemory] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const projectPromise = api.get<{ projects: ProjectRecord[] }>('/api/projects');
      const proposalPromise = api.get<{ items: ProposalRecord[]; counters: Record<string, number> }>(
        `/api/memory-proposals?status=${proposalStatus}&limit=100`,
      );
      const memoryParams = new URLSearchParams({ limit: '100' });
      if (memoryQuery.trim()) memoryParams.set('q', memoryQuery.trim());
      if (includeHistory) memoryParams.set('includeHistory', 'true');
      const memoryPromise = api.get<{ items: MemoryRecord[]; counters: Record<string, number> }>(
        `/api/memories?${memoryParams.toString()}`,
      );

      const [p, pr, me] = await Promise.all([projectPromise, proposalPromise, memoryPromise]);
      setProjects(p.projects);
      setProposals(pr.items);
      setCounters(pr.counters);
      setMemories(me.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [proposalStatus, memoryQuery, includeHistory]);

  useEffect(() => {
    void loadAll();
  }, [loadAll, refreshToken]);

  const projectName = new Map(projects.map((p) => [p.id, p.title]));

  if (error) return <Alert tone="danger" title="加载失败">{error}</Alert>;

  return (
    <div className="stack">
      <div className="grid cols-3">
        <Card tight>
          <div className="metric">
            <span className="metric-label">待审核候选</span>
            <span className="metric-value small">{counters.pendingProposals ?? 0}</span>
            <span className="metric-note">未批准前不会进入任何上下文包</span>
          </div>
        </Card>
        <Card tight>
          <div className="metric">
            <span className="metric-label">生效中的记忆</span>
            <span className="metric-value small">{counters.active ?? 0}</span>
            <span className="metric-note">
              已归档 {counters.archived ?? 0} · 已过期 {counters.expired ?? 0} · 已被替代 {counters.superseded ?? 0}
            </span>
          </div>
        </Card>
        <Card tight>
          <div className="metric">
            <span className="metric-label">墓碑</span>
            <span className="metric-value small">{counters.tombstones ?? 0}</span>
            <span className="metric-note">只含哈希。旧导入包命中它们时会要求重新确认</span>
          </div>
        </Card>
      </div>

      <div className="pill-group">
        <button className={`tag-btn${tab === 'proposals' ? ' active' : ''}`} onClick={() => setTab('proposals')}>
          候选箱
        </button>
        <button className={`tag-btn${tab === 'library' ? ' active' : ''}`} onClick={() => setTab('library')}>
          正式库
        </button>
      </div>

      {tab === 'proposals' ? (
        <>
          <Card tight>
            <div className="row" style={{ gap: 8 }}>
              <span className="tiny muted">状态：</span>
              <div className="pill-group">
                {(
                  [
                    ['pending', '待审核'],
                    ['conflict', '版本冲突'],
                    ['approved', '已批准'],
                    ['rejected', '已驳回'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    className={`tag-btn${proposalStatus === key ? ' active' : ''}`}
                    onClick={() => setProposalStatus(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </Card>

          {loading && proposals.length === 0 ? (
            <div className="faint">加载中…</div>
          ) : proposals.length === 0 ? (
            <EmptyState
              kind="connected_no_data"
              title={proposalStatus === 'pending' ? '候选箱是空的' : '这个状态下没有候选'}
            >
              <span>到「ChatGPT 桥接」页粘贴一段候选 JSON，或在这里手动新建一条候选。</span>
            </EmptyState>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {proposals.map((p) => (
                <Card key={p.id} tight>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="row tight">
                        <Badge tone={statusTone(p.status)}>{STATUS_LABEL[p.status] ?? p.status}</Badge>
                        <Badge tone="ghost">{KIND_LABEL[p.kind] ?? p.kind}</Badge>
                        <Badge tone="ghost">{p.operation}</Badge>
                        {p.targetMemoryId ? <Badge tone="ghost">目标 v{p.baseVersion ?? '?'}</Badge> : null}
                        {p.duplicateOfProposalId ? <Badge tone="warn">有完全相同的候选</Badge> : null}
                      </div>
                      <div style={{ marginTop: 6, fontWeight: 600 }}>{p.title}</div>
                      <div className="muted small-text clamp-3" style={{ marginTop: 2 }}>
                        {p.content}
                      </div>
                      <div className="faint tiny" style={{ marginTop: 4 }}>
                        {p.projectId ? (projectName.get(p.projectId) ?? p.projectId) : '全局'} · 来源{' '}
                        {p.sourceKind}
                        {p.sourceRef ? ` (${p.sourceRef})` : '（无可验证链接）'} · {formatRelative(p.createdAt)}
                      </div>
                      {p.evidenceStatus === 'user_confirmation_required' ? (
                        <div className="warn-text tiny" style={{ marginTop: 4 }}>
                          需要你确认：模型生成过这段摘要，不等于你确认过其中每一项。
                        </div>
                      ) : null}
                      {p.conflictDetail ? (
                        <div className="danger-text tiny" style={{ marginTop: 4 }}>
                          此候选已被判为版本冲突，需要基于新版本重新提交。
                        </div>
                      ) : null}
                    </div>
                    <button className="primary small" onClick={() => setOpenProposal(p.id)}>
                      {p.status === 'pending' ? '审核' : '查看'}
                    </button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <Card tight>
            <div className="row">
              <input
                value={memoryQuery}
                onChange={(e) => setMemoryQuery(e.target.value)}
                placeholder="搜索标题或正文（中文短词也能查到）"
                style={{ maxWidth: 320 }}
              />
              <label className="checkline">
                <input type="checkbox" checked={includeHistory} onChange={(e) => setIncludeHistory(e.target.checked)} />
                <span>包含已替代 / 已归档 / 已过期（历史视图）</span>
              </label>
            </div>
          </Card>

          {memories.length === 0 ? (
            <EmptyState kind="connected_no_data" title="正式库里还没有内容">
              <span>正式记忆只能由候选审核通过产生，不存在「直接写入」的入口。</span>
            </EmptyState>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {memories.map((m) => (
                <Card key={m.id} tight>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="row tight">
                        <Badge tone={statusTone(m.status)}>{STATUS_LABEL[m.status] ?? m.status}</Badge>
                        <Badge tone="ghost">{KIND_LABEL[m.kind] ?? m.kind}</Badge>
                        <Badge tone="ghost">v{m.version}</Badge>
                        {m.pinned ? <Badge tone="accent">已固定</Badge> : null}
                        {m.sensitivity !== 'normal' ? <Badge tone="danger">{m.sensitivity}</Badge> : null}
                      </div>
                      <div style={{ marginTop: 6, fontWeight: 600 }}>{m.title}</div>
                      <div className="muted small-text clamp-3" style={{ marginTop: 2 }}>
                        {m.content}
                      </div>
                      <div className="faint tiny" style={{ marginTop: 4 }}>
                        {m.projectId ? (projectName.get(m.projectId) ?? m.projectId) : '全局'} ·{' '}
                        {VERIFICATION_LABEL[m.verification] ?? m.verification} · 更新于{' '}
                        {formatRelative(m.updatedAt)}
                      </div>
                    </div>
                    <button className="small" onClick={() => setOpenMemory(m.id)}>
                      详情
                    </button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {openProposal ? (
        <ProposalReview
          proposalId={openProposal}
          projectName={projectName}
          onClose={() => setOpenProposal(null)}
          onDone={async () => {
            setOpenProposal(null);
            await loadAll();
            reload();
          }}
          toast={toast}
        />
      ) : null}

      {openMemory ? (
        <MemoryDetail
          memoryId={openMemory}
          projectName={projectName}
          onClose={() => setOpenMemory(null)}
          onDone={async () => {
            setOpenMemory(null);
            await loadAll();
            reload();
          }}
          toast={toast}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 候选审核                                                            */
/* ------------------------------------------------------------------ */

interface ProposalDetailResponse {
  proposal: ProposalRecord;
  target: MemoryRecord | null;
  diff: { lines: Array<{ kind: 'same' | 'add' | 'remove'; text: string }>; added: number; removed: number; truncated: boolean } | null;
  similar: Array<{ proposalId: string; title: string; similarity: number }>;
  reviewAllowed: boolean;
  reviewBlockedReason: string | null;
}

function ProposalReview({
  proposalId,
  projectName,
  onClose,
  onDone,
  toast,
}: {
  proposalId: string;
  projectName: Map<string, string>;
  onClose: () => void;
  onDone: () => Promise<void>;
  toast: PageProps['toast'];
}): ReactNode {
  const [detail, setDetail] = useState<ProposalDetailResponse | null>(null);
  const [overrideTitle, setOverrideTitle] = useState('');
  const [overrideContent, setOverrideContent] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [ackTombstone, setAckTombstone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<ProposalDetailResponse>(`/api/memory-proposals/${proposalId}`)
      .then((d) => {
        setDetail(d);
        setOverrideTitle(d.proposal.title);
        setOverrideContent(d.proposal.content);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [proposalId]);

  const liveDiff = detail ? diffLines(detail.proposal.content, overrideContent) : null;

  const submit = async (decision: 'approve' | 'reject'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/memory-proposals/${proposalId}/review`, {
        decision,
        reviewedBy: 'local-user',
        reviewNote: reviewNote.trim() || null,
        overrideTitle: overrideTitle.trim() === detail?.proposal.title ? null : overrideTitle.trim(),
        overrideContent: overrideContent.trim() === detail?.proposal.content ? null : overrideContent,
        acknowledgeTombstone: ackTombstone,
      });
      toast(decision === 'approve' ? '已批准，正式记忆已生成。' : '已驳回。', decision === 'approve' ? 'ok' : 'info');
      await onDone();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      if (message.includes('墓碑') || message.includes('确认')) setAckTombstone(false);
      toast(message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  if (!detail) {
    return (
      <Modal title="候选详情" onClose={onClose}>
        {error ? <Alert tone="danger">{error}</Alert> : <div className="faint">加载中…</div>}
      </Modal>
    );
  }

  const p = detail.proposal;
  const editable = p.status === 'pending' && detail.reviewAllowed;

  return (
    <Modal
      title={editable ? '审核候选' : '候选详情'}
      subtitle={
        <>
          {p.operation === 'create' ? '新建' : p.operation === 'update' ? '更新' : '归档'} ·{' '}
          {p.projectId ? (projectName.get(p.projectId) ?? p.projectId) : '全局'} ·{' '}
          {p.status === 'pending' ? '等待你核对' : STATUS_LABEL[p.status]}
        </>
      }
      onClose={onClose}
      wide
    >
      <div className="stack">
        {/* 来源在左、候选在右 */}
        <div className="grid cols-2">
          <Card tight title="来源（这条是怎么来的）">
            <div className="kv">
              <dt>来源类型</dt>
              <dd className="mono">{p.sourceKind}</dd>
              <dt>来源链接</dt>
              <dd>
                {p.sourceRef ? (
                  <span className="mono">{p.sourceRef}</span>
                ) : (
                  <span className="warn-text">
                    为空。模型生成过这段摘要，但系统不会替你编一个可验证链接。
                  </span>
                )}
              </dd>
              <dt>证据状态</dt>
              <dd>
                {p.evidenceStatus === 'verified' ? (
                  <Badge tone="ok">有原文证据</Badge>
                ) : p.evidenceStatus === 'user_confirmation_required' ? (
                  <Badge tone="warn">需要你确认</Badge>
                ) : (
                  <Badge tone="neutral">未知</Badge>
                )}
              </dd>
              <dt>创建时间</dt>
              <dd>{formatDateTime(p.createdAt)}</dd>
            </div>
            {p.evidenceQuote ? (
              <>
                <div className="sep" />
                <div className="card-hint">原文引用</div>
                <blockquote className="pre-wrap small-text" style={{ margin: '6px 0 0', paddingLeft: 10, borderLeft: '3px solid var(--border)' }}>
                  {p.evidenceQuote}
                </blockquote>
              </>
            ) : (
              <>
                <div className="sep" />
                <div className="notice">
                  没有原文引用。这意味着「模型生成过这段文字」是唯一可以确定的事 ——
                  它不能证明你说过、也不能证明你同意过每一项。
                </div>
              </>
            )}
          </Card>

          <Card tight title="候选内容（这条准备存成什么）">
            <div className="stack" style={{ gap: 8 }}>
              <label className="field">
                <span>标题</span>
                <input value={overrideTitle} onChange={(e) => setOverrideTitle(e.target.value)} disabled={!editable} />
              </label>
              <label className="field">
                <span>正文</span>
                <textarea
                  value={overrideContent}
                  onChange={(e) => setOverrideContent(e.target.value)}
                  rows={9}
                  disabled={!editable}
                />
                <span className="help">批准前可以直接改。改动会作为「用户编辑」记录在案，和提案原文的差异会保留。</span>
              </label>
              <div className="kv">
                <dt>类型 / 范围</dt>
                <dd>
                  {KIND_LABEL[p.kind] ?? p.kind} · {p.scope}
                </dd>
                <dt>敏感等级</dt>
                <dd>
                  <Badge tone={p.sensitivity === 'normal' ? 'neutral' : 'danger'}>{p.sensitivity}</Badge>
                </dd>
                <dt>验证状态</dt>
                <dd>{VERIFICATION_LABEL[p.verification] ?? p.verification}</dd>
              </div>
            </div>
          </Card>
        </div>

        {/* 差异在下 */}
        <Card
          tight
          title={detail.target ? `与现有记忆（v${detail.target.version}）的差异` : '差异预览'}
          hint={detail.target ? undefined : '这是新建候选，不存在可比较的旧版本'}
        >
          {!detail.target ? (
            <EmptyState kind="not_configured" title="新建，没有旧版本可比" />
          ) : (liveDiff?.lines.length ?? 0) === 0 ? (
            <div className="notice">正文与当前版本完全一致，没有实质变更。</div>
          ) : (
            <>
              <div className="diff">
                {liveDiff?.lines.map((line, i) => (
                  <div className={`diff-line ${line.kind}`} key={i}>
                    <span className="mark">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}</span>
                    <span>{line.text}</span>
                  </div>
                ))}
              </div>
              <div className="notice" style={{ marginTop: 6 }}>
                +{liveDiff?.added ?? 0} 行 / -{liveDiff?.removed ?? 0} 行
                {liveDiff?.truncated ? '（文本过长，已退化为前后缀比较）' : ''}
              </div>
            </>
          )}
        </Card>

        {detail.similar.length > 0 ? (
          <Alert tone="warn" title={`有 ${detail.similar.length} 条语义相近的待审候选`}>
            <ul className="list-plain">
              {detail.similar.map((s) => (
                <li key={s.proposalId}>
                  {s.title}（相似度 {(s.similarity * 100).toFixed(0)}%）
                </li>
              ))}
            </ul>
            <span className="alert-hint">只是提示，系统不会自动合并或删除任何一条。</span>
          </Alert>
        ) : null}

        {p.conflictDetail ? (
          <Alert tone="danger" title="这条候选已被判为版本冲突">
            <span className="mono tiny pre-wrap">{p.conflictDetail}</span>
            <span className="alert-hint">
              冲突不会自动合并。请基于当前版本重新提交一份提案后再次审核。
            </span>
          </Alert>
        ) : null}

        {!detail.reviewAllowed ? (
          <Alert tone="warn" title="当前主体不能审批">
            <span>{detail.reviewBlockedReason}</span>
            <span className="alert-hint">
              提版权和批准权刻意不在同一个主体手里：AI 可以提交候选，但批准只属于你。
            </span>
          </Alert>
        ) : null}

        {error ? <Alert tone="danger">{error}</Alert> : null}

        {editable ? (
          <>
            <label className="field">
              <span>审核备注（可选）</span>
              <input
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
                placeholder="例如「与我的实际说法一致」"
              />
            </label>
            <label className="checkline">
              <input type="checkbox" checked={ackTombstone} onChange={(e) => setAckTombstone(e.target.checked)} />
              <span>
                我确认这条内容此前被删除过，仍然要重新建立（命中墓碑时必须勾选，否则批准会被拒绝）
              </span>
            </label>
          </>
        ) : null}
      </div>

      <div className="modal-foot">
        <button className="ghost" onClick={onClose}>
          取消
        </button>
        {editable ? (
          <>
            <button className="danger" disabled={busy} onClick={() => void submit('reject')}>
              驳回
            </button>
            <button className="primary" disabled={busy} onClick={() => void submit('approve')}>
              {busy ? '提交中…' : '批准并生成正式记忆'}
            </button>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* 正式记忆详情                                                        */
/* ------------------------------------------------------------------ */

interface MemoryDetailResponse {
  memory: MemoryRecord;
  revisions: Array<{ version: number; changeKind: string; changedBy: string; changedAt: string; note: string | null; title: string; content: string }>;
  supersedes: MemoryRecord | null;
  referencedExports: Array<{ id: string; createdAt: string; invalidatedAt: string | null }>;
  relatedSessions: Array<{ id: string; createdAt: string }>;
  project: { id: string; title: string } | null;
}

interface DeletePreviewResponse {
  preview: {
    memoryId: string;
    title: string;
    version: number;
    willDelete: { currentContent: boolean; revisionCount: number; revisionVersions: number[] };
    exportsToInvalidate: Array<{ id: string; createdAt: string; projectId: string }>;
    cannotDelete: string[];
    tombstone: { willCreate: boolean; contentHash: string; alreadyExists: boolean; note: string };
    relatedSessions: Array<{ id: string; createdAt: string }>;
  };
  note: string;
}

function MemoryDetail({
  memoryId,
  projectName,
  onClose,
  onDone,
  toast,
}: {
  memoryId: string;
  projectName: Map<string, string>;
  onClose: () => void;
  onDone: () => Promise<void>;
  toast: PageProps['toast'];
}): ReactNode {
  const [detail, setDetail] = useState<MemoryDetailResponse | null>(null);
  const [deletePreview, setDeletePreview] = useState<DeletePreviewResponse['preview'] | null>(null);
  const [compareVersion, setCompareVersion] = useState<number | null>(null);
  const [deleteReason, setDeleteReason] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await api.get<MemoryDetailResponse>(`/api/memories/${memoryId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [memoryId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, message: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast(message, 'ok');
      await onDone();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setError(text);
      toast(text, 'danger');
    } finally {
      setBusy(false);
    }
  };

  if (!detail) {
    return (
      <Modal title="记忆详情" onClose={onClose}>
        {error ? <Alert tone="danger">{error}</Alert> : <div className="faint">加载中…</div>}
      </Modal>
    );
  }

  const m = detail.memory;
  const compareRevision = detail.revisions.find((r) => r.version === compareVersion);
  const diff = compareRevision ? diffLines(compareRevision.content, m.content) : null;

  return (
    <Modal
      title={m.title}
      subtitle={
        <>
          {KIND_LABEL[m.kind] ?? m.kind} · v{m.version} · {STATUS_LABEL[m.status] ?? m.status} ·{' '}
          {detail.project ? detail.project.title : '全局'} · 批准人 {m.approvedBy}
        </>
      }
      onClose={onClose}
      wide
    >
      <div className="stack">
        <div className="card tight">
          <div className="pre-wrap">{m.content}</div>
        </div>

        <div className="grid cols-2">
          <Card tight title="属性">
            <div className="kv">
              <dt>记忆 ID</dt>
              <dd className="mono">{m.id}</dd>
              <dt>范围</dt>
              <dd>
                {m.scope}
                {m.projectId ? ` · ${projectName.get(m.projectId) ?? m.projectId}` : ''}
              </dd>
              <dt>验证状态</dt>
              <dd>{VERIFICATION_LABEL[m.verification] ?? m.verification}</dd>
              <dt>敏感等级</dt>
              <dd>{m.sensitivity}</dd>
              <dt>创建 / 更新</dt>
              <dd>
                {formatDateTime(m.updatedAt)}
                <div className="faint tiny">{formatRelative(m.updatedAt)}</div>
              </dd>
            </div>
            <div className="sep" />
            <div className="row tight">
              <button
                className="small"
                disabled={busy}
                onClick={() => void act(() => api.post(`/api/memories/${m.id}/pin`, { pinned: !m.pinned }), m.pinned ? '已取消固定' : '已固定')}
              >
                {m.pinned ? '取消固定' : '固定（优先进入上下文包）'}
              </button>
              {m.status === 'active' ? (
                <button
                  className="small"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => api.post(`/api/memories/${m.id}/transition`, { status: 'archived', note: '用户手动归档' }),
                      '已归档。历史版本保留，仍可在历史视图检索。',
                    )
                  }
                >
                  归档
                </button>
              ) : (
                <button
                  className="small"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => api.post(`/api/memories/${m.id}/transition`, { status: 'active', note: '用户手动恢复' }),
                      '已恢复为生效中。',
                    )
                  }
                >
                  恢复
                </button>
              )}
            </div>
          </Card>

          <Card tight title="版本历史" hint="每次变更都会追加一条，包括当前版本">
            <div className="stack" style={{ gap: 6 }}>
              {detail.revisions.map((r) => (
                <div key={r.version} className="row" style={{ justifyContent: 'space-between', gap: 10 }}>
                  <div>
                    <div>
                      <strong>v{r.version}</strong>{' '}
                      <span className="faint tiny">
                        {r.changeKind} · {r.changedBy} · {formatRelative(r.changedAt)}
                      </span>
                    </div>
                    {r.note ? <div className="faint tiny">{r.note}</div> : null}
                  </div>
                  {r.version !== m.version ? (
                    <button
                      className="ghost small"
                      onClick={() => setCompareVersion(compareVersion === r.version ? null : r.version)}
                    >
                      {compareVersion === r.version ? '收起差异' : `与 v${r.version} 比较`}
                    </button>
                  ) : (
                    <Badge tone="ok">当前版本</Badge>
                  )}
                </div>
              ))}
              {detail.supersedes ? (
                <div className="notice">
                  这条记忆替代了 <span className="mono">{detail.supersedes.id}</span>（v{detail.supersedes.version}）。
                  替代关系是显式记录的，不是靠日期推测的。
                </div>
              ) : null}
            </div>
            {diff ? (
              <>
                <div className="sep" />
                <div className="diff">
                  {diff.lines.map((line, i) => (
                    <div className={`diff-line ${line.kind}`} key={i}>
                      <span className="mark">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}</span>
                      <span>{line.text}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </Card>
        </div>

        {detail.referencedExports.length > 0 ? (
          <Card tight title="引用了这条记忆的上下文包" hint="记忆更新后它们会被标记失效">
            <div className="stack" style={{ gap: 4 }}>
              {detail.referencedExports.map((e) => (
                <div key={e.id} className="row tiny" style={{ justifyContent: 'space-between' }}>
                  <span className="mono">{e.id}</span>
                  <span className={e.invalidatedAt ? 'warn-text' : 'faint'}>
                    {formatDateTime(e.createdAt)}
                    {e.invalidatedAt ? ' · 已失效' : ' · 仍然有效'}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        ) : null}

        <Card
          tight
          title="删除"
          hint="永久删除不能藏在普通保存按钮后面，所以它在这里单独出现"
        >
          {!deletePreview ? (
            <div className="row">
              <button
                className="danger small"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await api.post<DeletePreviewResponse>(`/api/memories/${m.id}/delete-preview`);
                    setDeletePreview(result.preview);
                  } catch (err) {
                    toast(err instanceof Error ? err.message : String(err), 'danger');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                查看删除影响（不会删除任何东西）
              </button>
            </div>
          ) : (
            <div className="stack">
              <div className="kv">
                <dt>将删除</dt>
                <dd>
                  正式正文 1 份 + 历史版本 {deletePreview.willDelete.revisionCount} 个（
                  {deletePreview.willDelete.revisionVersions.map((v) => `v${v}`).join('、') || '无'}）
                </dd>
                <dt>将标记失效</dt>
                <dd>
                  {deletePreview.exportsToInvalidate.length === 0
                    ? '没有上下文包引用它'
                    : `${deletePreview.exportsToInvalidate.length} 个包`}
                </dd>
                <dt>墓碑</dt>
                <dd>
                  会创建一行只含哈希的墓碑
                  {deletePreview.tombstone.alreadyExists ? '（已存在）' : ''}
                  <div className="faint tiny mono">{deletePreview.tombstone.contentHash.slice(0, 32)}…</div>
                </dd>
              </div>

              <Alert tone="warn" title="以下内容不随本次删除消失">
                <ul className="list-plain">
                  {deletePreview.cannotDelete.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
                <span className="alert-hint">
                  本系统不能撤回已经复制到其他工具的文本，也不能替你在别的平台删除原生记忆。
                  删除范围清单是为了让你知道自己到底控制了什么、没控制什么。
                </span>
              </Alert>

              <label className="field">
                <span>删除原因（必填，会写入审计）</span>
                <input
                  value={deleteReason}
                  onChange={(e) => setDeleteReason(e.target.value)}
                  placeholder="例如「这条信息来源不可靠」"
                />
              </label>
              <label className="checkline">
                <input type="checkbox" checked={confirmDelete} onChange={(e) => setConfirmDelete(e.target.checked)} />
                <span>
                  <strong>我已阅读上面的影响清单，确认永久删除。</strong>此操作不可撤销。
                </span>
              </label>

              <div className="row">
                <button className="ghost small" onClick={() => setDeletePreview(null)}>
                  取消
                </button>
                <button
                  className="danger small"
                  disabled={busy || !confirmDelete || deleteReason.trim().length === 0}
                  onClick={() =>
                    void act(
                      () =>
                        api.delete(`/api/memories/${m.id}`, {
                          reason: deleteReason.trim(),
                          confirm: true,
                          deletedBy: 'local-user',
                        }),
                      '删除完成。上面列出的外部副本仍然存在。',
                    )
                  }
                >
                  确认永久删除
                </button>
              </div>
            </div>
          )}
        </Card>

        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>

      <div className="modal-foot">
        <button className="ghost" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
