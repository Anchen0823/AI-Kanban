import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type ContextExportSummary, type MemoryRecord, type ProjectRecord } from '../api.js';
import type { PageProps } from '../App.js';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  KIND_LABEL,
  Modal,
  copyText,
  formatDateTime,
  formatRelative,
} from '../ui.js';

/**
 * 项目页。
 *
 * 一个项目卡片要回答的问题是：「如果现在换一个工具继续做，我需要告诉它什么？」
 * 所以这里最重的动作是「生成上下文包」，而包里必须包含**已尝试且失败的路径** ——
 * 这恰恰是最容易被遗漏、又最容易让另一个 agent 重做一遍的东西。
 */

export function ProjectsPage({ refreshToken, reload, toast }: PageProps): ReactNode {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [memoryCounts, setMemoryCounts] = useState<Record<string, number>>({});
  const [exports, setExports] = useState<ContextExportSummary[]>([]);
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, m, e] = await Promise.all([
        api.get<{ projects: ProjectRecord[] }>('/api/projects'),
        api.get<{ items: MemoryRecord[] }>('/api/memories?limit=200'),
        api.get<{ exports: ContextExportSummary[] }>('/api/context-exports?limit=100'),
      ]);
      setProjects(p.projects);
      const counts: Record<string, number> = {};
      for (const memory of m.items) {
        if (!memory.projectId) continue;
        counts[memory.projectId] = (counts[memory.projectId] ?? 0) + 1;
      }
      setMemoryCounts(counts);
      setExports(e.exports);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  if (error) return <Alert tone="danger" title="加载失败">{error}</Alert>;

  return (
    <div className="stack">
      <Card
        tight
        title="项目"
        hint="目标、当前状态、决策、失败路径与交接材料"
        actions={
          <button className="primary small" onClick={() => setShowCreate(true)}>
            新建项目
          </button>
        }
      >
        {loading && projects.length === 0 ? (
          <div className="faint">加载中…</div>
        ) : projects.length === 0 ? (
          <EmptyState kind="not_configured" title="还没有登记任何项目">
            <span>
              项目是记忆的作用范围、用量的归属对象，也是上下文包的组织单位。
              先建一个项目，再让候选记忆挂到它上面。
            </span>
          </EmptyState>
        ) : (
          <div className="grid cols-2">
            {projects.map((p) => {
              const projectExports = exports.filter((e) => e.projectId === p.id);
              return (
                <div className="card tight" key={p.id} style={{ boxShadow: 'none' }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 620 }}>{p.title}</div>
                      <div className="faint tiny">
                        {p.id}
                        {p.repoAlias ? ` · ${p.repoAlias}` : ''}
                      </div>
                    </div>
                    <Badge tone={p.status === 'active' ? 'ok' : 'neutral'}>{p.status}</Badge>
                  </div>
                  {p.goal ? <div className="muted small-text" style={{ marginTop: 6 }}>{p.goal}</div> : null}
                  <div className="sep" />
                  <div className="row tiny faint" style={{ gap: 14 }}>
                    <span>生效记忆 {memoryCounts[p.id] ?? 0} 条</span>
                    <span>上下文包 {projectExports.length} 个</span>
                    {projectExports.some((e) => e.invalidatedAt) ? (
                      <span className="warn-text">{projectExports.filter((e) => e.invalidatedAt).length} 个已失效</span>
                    ) : null}
                  </div>
                  <div className="row tight" style={{ marginTop: 10 }}>
                    <button className="small" onClick={() => setOpenProject(p.id)}>
                      打开
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card tight title="最近的上下文包" hint="包的清单记录了每条记忆的 ID 与版本">
        {exports.length === 0 ? (
          <EmptyState kind="connected_no_data" title="还没有生成过上下文包">
            <span>在项目里点「生成上下文包」，把当前状态交接给另一个客户端。</span>
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>项目</th>
                  <th>预算</th>
                  <th className="num">条目</th>
                  <th className="num">估算 token</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {exports.slice(0, 20).map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap tiny">{formatDateTime(e.createdAt)}</td>
                    <td className="tiny">
                      {projects.find((p) => p.id === e.projectId)?.title ?? e.projectId}
                    </td>
                    <td className="tiny">{e.budgetKind}</td>
                    <td className="num">{e.itemCount}</td>
                    <td className="num">{e.estimatedTokens}</td>
                    <td className="tiny">
                      {e.invalidatedAt ? (
                        <span className="warn-text" title={e.invalidatedReason ?? ''}>
                          已失效
                        </span>
                      ) : (
                        <Badge tone="ok">有效</Badge>
                      )}
                      {e.droppedCount > 0 ? <div className="faint">删减 {e.droppedCount} 条</div> : null}
                      {e.excludedByPolicy > 0 ? <div className="faint">权限排除 {e.excludedByPolicy} 条</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {showCreate ? (
        <CreateProject
          onClose={() => setShowCreate(false)}
          onDone={async () => {
            setShowCreate(false);
            await load();
            reload();
          }}
          toast={toast}
        />
      ) : null}

      {openProject ? (
        <ProjectDetail
          projectId={openProject}
          onClose={() => setOpenProject(null)}
          onChanged={async () => {
            await load();
            reload();
          }}
          toast={toast}
        />
      ) : null}
    </div>
  );
}

function CreateProject({
  onClose,
  onDone,
  toast,
}: {
  onClose: () => void;
  onDone: () => Promise<void>;
  toast: PageProps['toast'];
}): ReactNode {
  const [form, setForm] = useState({ title: '', goal: '', handoffSummary: '', repoAlias: '' });
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title="新建项目"
      subtitle="项目是记忆的作用范围与用量的归属对象。它不需要一开始就填得很完整。"
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || form.title.trim().length === 0}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post('/api/projects', {
                  title: form.title.trim(),
                  goal: form.goal.trim() || null,
                  handoffSummary: form.handoffSummary.trim() || null,
                  repoAlias: form.repoAlias.trim() || null,
                });
                toast('项目已创建。', 'ok');
                await onDone();
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), 'danger');
              } finally {
                setBusy(false);
              }
            }}
          >
            创建
          </button>
        </>
      }
    >
      <div className="stack">
        <label className="field">
          <span>标题</span>
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus />
        </label>
        <label className="field">
          <span>目标</span>
          <textarea
            value={form.goal}
            onChange={(e) => setForm({ ...form, goal: e.target.value })}
            rows={3}
            style={{ fontFamily: 'inherit' }}
            placeholder="这个项目要做到什么。写得具体一点，它对上下文包的相关性排序有影响。"
          />
        </label>
        <label className="field">
          <span>交接摘要</span>
          <textarea
            value={form.handoffSummary}
            onChange={(e) => setForm({ ...form, handoffSummary: e.target.value })}
            rows={3}
            style={{ fontFamily: 'inherit' }}
            placeholder="如果现在换一个工具继续，你第一句会说什么？"
          />
        </label>
        <label className="field">
          <span>仓库别名（可选）</span>
          <input
            value={form.repoAlias}
            onChange={(e) => setForm({ ...form, repoAlias: e.target.value })}
            placeholder="只存别名，不抓取仓库内容"
          />
        </label>
      </div>
    </Modal>
  );
}

function ProjectDetail({
  projectId,
  onClose,
  onChanged,
  toast,
}: {
  projectId: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
  toast: PageProps['toast'];
}): ReactNode {
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [sessions, setSessions] = useState<Array<{ id: string; createdAt: string; summary: string | null }>>([]);
  const [preview, setPreview] = useState<{ totalCandidates: number; totalEstimatedTokens: number } | null>(null);
  const [packaged, setPackaged] = useState<{ markdown: string; exportId: string | null; manifest: { estimatedTokens: number; droppedCount: number } } | null>(null);
  const [task, setTask] = useState('');
  const [budgetKind, setBudgetKind] = useState<'short' | 'standard'>('standard');
  const [includeGlobal, setIncludeGlobal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [handoff, setHandoff] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, m, s, c] = await Promise.all([
        api.get<{ projects: ProjectRecord[] }>('/api/projects'),
        api.get<{ items: MemoryRecord[] }>(`/api/memories?projectId=${projectId}&includeHistory=true&limit=200`),
        api.get<{ sessions: Array<{ id: string; createdAt: string; summary: string | null }> }>(
          `/api/sessions?projectId=${projectId}`,
        ),
        api.get<{ totalCandidates: number; totalEstimatedTokens: number }>(
          `/api/projects/${projectId}/context-preview`,
        ),
      ]);
      const found = p.projects.find((x) => x.id === projectId) ?? null;
      setProject(found);
      setHandoff(found?.handoffSummary ?? '');
      setMemories(m.items);
      setSessions(s.sessions);
      setPreview({ totalCandidates: c.totalCandidates, totalEstimatedTokens: c.totalEstimatedTokens });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{
        exportId: string;
        markdown: string;
        manifest: { estimatedTokens: number; droppedCount: number };
        requiresUserChoice: boolean;
        note: string;
      }>('/api/context-exports', {
        projectId,
        task: task.trim() || null,
        budgetKind,
        includeGlobalMemory: includeGlobal,
      });
      setPackaged(result);
      toast(
        result.requiresUserChoice
          ? '固定项超出预算，请先取舍后再生成。'
          : `上下文包已生成（约 ${result.manifest.estimatedTokens} token，估算）。`,
        result.requiresUserChoice ? 'warn' : 'ok',
      );
      await onChanged();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast(message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  if (!project) {
    return (
      <Modal title="项目详情" onClose={onClose}>
        {error ? <Alert tone="danger">{error}</Alert> : <div className="faint">加载中…</div>}
      </Modal>
    );
  }

  const activeMemories = memories.filter((m) => m.status === 'active');
  const lessons = activeMemories.filter((m) => m.kind === 'lesson');

  return (
    <Modal
      title={project.title}
      subtitle={
        <>
          {project.id} · {project.status}
          {project.repoAlias ? ` · ${project.repoAlias}` : ''}
        </>
      }
      onClose={onClose}
      wide
    >
      <div className="stack">
        {error ? <Alert tone="danger">{error}</Alert> : null}

        <div className="grid cols-3">
          <Card tight>
            <div className="metric">
              <span className="metric-label">生效记忆</span>
              <span className="metric-value small">{activeMemories.length}</span>
              <span className="metric-note">
                历史版本共 {memories.length - activeMemories.length} 条（已归档 / 已过期 / 已被替代）
              </span>
            </div>
          </Card>
          <Card tight>
            <div className="metric">
              <span className="metric-label">失败路径记录</span>
              <span className="metric-value small">{lessons.length}</span>
              <span className="metric-note">这类记录决定了另一个 agent 会不会重做一遍</span>
            </div>
          </Card>
          <Card tight>
            <div className="metric">
              <span className="metric-label">全量装入估算</span>
              <span className="metric-value small">{preview?.totalEstimatedTokens ?? '—'}</span>
              <span className="metric-note">
                共 {preview?.totalCandidates ?? 0} 条候选（含全局），用于挑预算
              </span>
            </div>
          </Card>
        </div>

        <Card tight title="目标与交接摘要">
          <div className="stack" style={{ gap: 8 }}>
            {project.goal ? <div className="small-text">{project.goal}</div> : <div className="faint tiny">尚未填写目标</div>}
            <label className="field">
              <span>交接摘要</span>
              <textarea
                value={handoff}
                onChange={(e) => setHandoff(e.target.value)}
                rows={3}
                style={{ fontFamily: 'inherit' }}
              />
              <span className="help">
                这段文字会出现在上下文包的开头。写「现在卡在哪」比写「做了什么」更有用。
              </span>
            </label>
            <div className="row tight">
              <button
                className="small"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.patch(`/api/projects/${projectId}`, { handoffSummary: handoff.trim() || null });
                    toast('交接摘要已保存。', 'ok');
                    await onChanged();
                  } catch (err) {
                    toast(err instanceof Error ? err.message : String(err), 'danger');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                保存交接摘要
              </button>
            </div>
          </div>
        </Card>

        <Card
          tight
          title="生成上下文包"
          hint="短版约 1,000 token、标准版约 2,500 token；计数为估算值"
        >
          <div className="grid cols-2">
            <label className="field" style={{ gridColumn: 'span 2' }}>
              <span>本次目标</span>
              <textarea
                value={task}
                onChange={(e) => setTask(e.target.value)}
                rows={2}
                style={{ fontFamily: 'inherit' }}
                placeholder="例如「把当前决策交接给 Cursor，继续做长将判负的边界用例」"
              />
              <span className="help">任务描述会影响相关性排序：与任务用词重合的记忆会优先进入包内。</span>
            </label>
            <label className="field">
              <span>预算</span>
              <select value={budgetKind} onChange={(e) => setBudgetKind(e.target.value as 'short' | 'standard')}>
                <option value="short">短版（约 1,000 token）</option>
                <option value="standard">标准版（约 2,500 token）</option>
              </select>
            </label>
            <label className="checkline" style={{ alignSelf: 'end', paddingBottom: 6 }}>
              <input type="checkbox" checked={includeGlobal} onChange={(e) => setIncludeGlobal(e.target.checked)} />
              <span>
                纳入全局记忆（默认<strong>不</strong>纳入：避免把整份个人画像塞给每个 agent）
              </span>
            </label>
          </div>
          <div className="modal-foot" style={{ border: 'none', paddingTop: 8 }}>
            <button className="primary" disabled={busy} onClick={() => void generate()}>
              {busy ? '生成中…' : '生成上下文包'}
            </button>
          </div>
        </Card>

        {packaged ? (
          <Card
            tight
            title="上下文包"
            hint={`约 ${packaged.manifest.estimatedTokens} token（估算）· 包 ID ${packaged.exportId ?? '未落库'}`}
            actions={
              <>
                <button
                  className="small"
                  onClick={async () => {
                    const ok = await copyText(packaged.markdown);
                    toast(ok ? '已复制到剪贴板，粘贴到目标客户端即可。' : '复制失败，请手动全选复制。', ok ? 'ok' : 'warn');
                  }}
                >
                  复制 Markdown
                </button>
                <button
                  className="small"
                  onClick={() => {
                    const blob = new Blob([packaged.markdown], { type: 'text/markdown;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = `context-${projectId}.md`;
                    link.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  下载 .md
                </button>
              </>
            }
          >
            <pre
              className="mono"
              style={{
                background: 'var(--surface-2)',
                padding: 12,
                borderRadius: 6,
                maxHeight: 360,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
              }}
            >
              {packaged.markdown}
            </pre>
            <div className="notice">
              包的清单记录了每条记忆的 ID 与版本。它可以证明本系统返回了哪些资料，
              不能证明目标模型一定读了、理解了或遵守了它们。
            </div>
          </Card>
        ) : null}

        <Card tight title={`项目内记忆（${memories.length} 条，含历史）`}>
          {memories.length === 0 ? (
            <EmptyState kind="connected_no_data" title="这个项目下还没有记忆" />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>标题</th>
                    <th>类型</th>
                    <th>状态</th>
                    <th className="num">版本</th>
                    <th>更新</th>
                  </tr>
                </thead>
                <tbody>
                  {memories.map((m) => (
                    <tr key={m.id}>
                      <td>{m.title}</td>
                      <td className="tiny">{KIND_LABEL[m.kind] ?? m.kind}</td>
                      <td className="tiny">
                        <Badge tone={m.status === 'active' ? 'ok' : 'neutral'}>{m.status}</Badge>
                      </td>
                      <td className="num">v{m.version}</td>
                      <td className="tiny faint">{formatRelative(m.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card tight title={`会话摘要（${sessions.length} 条）`} hint="只存来源会话 ID 与摘要，不存聊天全文">
          {sessions.length === 0 ? (
            <EmptyState kind="connected_no_data" title="还没有关联的会话摘要" />
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {sessions.map((session) => (
                <div key={session.id}>
                  <div className="faint tiny">
                    {session.id} · {formatDateTime(session.createdAt)}
                  </div>
                  <div className="small-text pre-wrap">{session.summary ?? '（无摘要）'}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="modal-foot">
        <button className="ghost" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
