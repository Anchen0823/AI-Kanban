import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type ContextExportSummary, type ProjectRecord } from '../api.js';
import type { PageProps } from '../App.js';
import { Alert, Badge, Card, EmptyState, copyText, formatDateTime, formatRelative } from '../ui.js';

/**
 * ChatGPT 桥接页。
 *
 * 这页存在的意义是把「不依赖任何新连接」这条路走通：不装插件、不配对、不授权，
 * 只靠剪贴板完成一次真实的跨工具交接。
 *
 * 界面话术上有一条硬线：没有外部写入工具时，只能显示「已生成候选」。
 * 一旦写成「已同步」，用户就会以为 ChatGPT 那边已经有这条记忆了 —— 而它没有。
 */

export function BridgePage({ refreshToken, reload, toast }: PageProps): ReactNode {
  const [prompt, setPrompt] = useState('');
  const [caveat, setCaveat] = useState('');
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [payload, setPayload] = useState('');
  const [fileName, setFileName] = useState('from-chatgpt.json');
  const [defaultProjectId, setDefaultProjectId] = useState('');
  const [mappingText, setMappingText] = useState('{}');
  const [dryRun, setDryRun] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [exports, setExports] = useState<ContextExportSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, pr, ex] = await Promise.all([
        api.get<{ prompt: string; caveat: string }>('/api/bridge/prompt'),
        api.get<{ projects: ProjectRecord[] }>('/api/projects'),
        api.get<{ exports: ContextExportSummary[] }>('/api/context-exports?limit=50'),
      ]);
      setPrompt(p.prompt);
      setCaveat(p.caveat);
      setProjects(pr.projects);
      setExports(ex.exports);
      if (!defaultProjectId && pr.projects.length > 0) setDefaultProjectId(pr.projects[0]?.id ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [defaultProjectId]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const importCandidates = async (): Promise<void> => {
    if (!payload.trim()) return toast('请先粘贴候选 JSON', 'warn');
    let mapping: Record<string, string> = {};
    try {
      mapping = JSON.parse(mappingText) as Record<string, string>;
    } catch {
      return toast('项目映射不是合法 JSON', 'danger');
    }

    setBusy(true);
    setError(null);
    try {
      const res = await api.post<Record<string, unknown>>('/api/memory-proposals/import', {
        fileName,
        content: payload,
        projectMapping: mapping,
        defaultProjectId: defaultProjectId || null,
        dryRun,
      });
      setResult(res);
      toast(
        dryRun
          ? `预检：会生成 ${(res.created as unknown[] | undefined)?.length ?? 0} 条候选，未写入。`
          : `已生成 ${(res.created as unknown[] | undefined)?.length ?? 0} 条候选，等待你审核。`,
        'ok',
      );
      if (!dryRun) {
        setPayload('');
        await load();
        reload();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast(message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  const created = (result?.created as Array<{ proposalId: string; title: string; warnings: string[] }> | undefined) ?? [];
  const rejected = (result?.rejected as Array<{ index: number; reason: string; title: string | null }> | undefined) ?? [];
  const unresolved = (result?.unresolvedProjects as string[] | undefined) ?? [];
  const warnings = (result?.warnings as string[] | undefined) ?? [];

  return (
    <div className="stack">
      <Alert tone="info" title="这条路径不依赖任何新连接">
        <span>
          不需要安装插件、不需要授权、也不使用任何凭据。你只需要在 ChatGPT 那边生成一段候选 JSON，
          复制到这里；需要把上下文带回去时，再复制过去。
        </span>
        <span className="alert-hint">{caveat}</span>
      </Alert>

      <div className="grid cols-2">
        <Card
          tight
          title="第一步：把提示词发给 ChatGPT"
          hint="这段提示词的每一句都在补模型的默认行为"
          actions={
            <button
              className="small"
              onClick={async () => {
                const ok = await copyText(prompt);
                toast(ok ? '提示词已复制。' : '复制失败，请手动全选。', ok ? 'ok' : 'warn');
              }}
            >
              复制提示词
            </button>
          }
        >
          <pre
            className="mono"
            style={{
              background: 'var(--surface-2)',
              padding: 12,
              borderRadius: 6,
              maxHeight: 300,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {prompt || '加载中…'}
          </pre>
          <ul className="list-plain" style={{ marginTop: 8 }}>
            <li>「不要把你的建议改写成我的偏好」——这是最常见的一种污染。</li>
            <li>「没有可靠原文时写 unknown，不要编造」——避免凭空造出一个来源链接。</li>
            <li>「不要声称已经写入或同步」——它确实没有写入任何东西。</li>
          </ul>
        </Card>

        <Card tight title="第二步：粘贴候选 JSON 进来" hint="这一步只会生成「待审核候选」，不会写正式记忆">
          <div className="stack" style={{ gap: 8 }}>
            <label className="field">
              <span>文件名</span>
              <input value={fileName} onChange={(e) => setFileName(e.target.value)} />
            </label>
            <label className="field">
              <span>候选 JSON</span>
              <textarea
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
                rows={10}
                placeholder='{"schema_version":"1.0","candidates":[{"scope":"project","project_id":"项目名","kind":"decision","title":"…","content":"…"}]}'
              />
              <span className="help">
                支持顶层 candidates 数组、裸数组，或单个对象（§6.3 的示例格式）。
              </span>
            </label>
            <div className="grid cols-2">
              <label className="field">
                <span>默认项目</span>
                <select value={defaultProjectId} onChange={(e) => setDefaultProjectId(e.target.value)}>
                  <option value="">不指定（候选必须自带可解析的项目）</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
                <span className="help">
                  候选里写的 project_id 会先按映射、再按 ID、最后按标题匹配。匹配不到时<strong>不会</strong>
                  自动创建项目。
                </span>
              </label>
              <label className="field">
                <span>项目映射（可选）</span>
                <input
                  value={mappingText}
                  onChange={(e) => setMappingText(e.target.value)}
                  className="mono"
                  placeholder='{"prove2me":"prj_xxx"}'
                />
                <span className="help">把候选里用的项目写法显式映射到本系统项目 ID。</span>
              </label>
            </div>
            <label className="checkline">
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
              <span>预检（不写库，只看会生成 / 拒绝哪些）</span>
            </label>
            <div className="row tight">
              <button className="primary" disabled={busy} onClick={() => void importCandidates()}>
                {busy ? '处理中…' : dryRun ? '预检候选' : '导入候选'}
              </button>
              <button
                className="ghost"
                onClick={() => {
                  setPayload('');
                  setResult(null);
                }}
              >
                清空
              </button>
            </div>
          </div>
        </Card>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {result ? (
        <Card
          tight
          title={dryRun ? '预检结果' : '导入结果'}
          hint="候选全部处于 pending 状态 —— 在人工批准之前，它们不会进入任何上下文包"
        >
          <div className="grid cols-3">
            <div className="metric">
              <span className="metric-label">已生成候选</span>
              <span className="metric-value small">{created.length}</span>
            </div>
            <div className="metric">
              <span className="metric-label">被拒绝</span>
              <span className="metric-value small danger-text">{rejected.length}</span>
            </div>
            <div className="metric">
              <span className="metric-label">未解析的项目引用</span>
              <span className="metric-value small warn-text">{unresolved.length}</span>
            </div>
          </div>

          <div className="sep" />

          <Alert tone="ok" title="已生成候选">
            <span>
              请注意措辞：这里是「已生成候选」，不是「已写入统一记忆」。
              本系统没有向 ChatGPT 写入任何东西，也没有从它那里同步任何东西。
            </span>
          </Alert>

          {created.length > 0 ? (
            <>
              <div className="sep" />
              <div className="card-title">生成的候选</div>
              <div className="table-wrap" style={{ marginTop: 6 }}>
                <table>
                  <thead>
                    <tr>
                      <th>标题</th>
                      <th>候选 ID</th>
                      <th>提醒</th>
                    </tr>
                  </thead>
                  <tbody>
                    {created.map((c) => (
                      <tr key={c.proposalId}>
                        <td>{c.title}</td>
                        <td className="mono tiny">{c.proposalId}</td>
                        <td className="tiny faint">
                          {c.warnings.length > 0 ? c.warnings.join('；') : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          {rejected.length > 0 ? (
            <>
              <div className="sep" />
              <div className="card-title danger-text">被拒绝的候选</div>
              <div className="table-wrap" style={{ marginTop: 6 }}>
                <table>
                  <thead>
                    <tr>
                      <th className="num">序号</th>
                      <th>标题</th>
                      <th>原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rejected.map((r) => (
                      <tr key={r.index}>
                        <td className="num">{r.index + 1}</td>
                        <td>{r.title ?? '—'}</td>
                        <td className="tiny">{r.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          {warnings.length > 0 ? (
            <>
              <div className="sep" />
              <div className="card-title">提醒</div>
              <ul className="list-plain">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </>
          ) : null}

          {unresolved.length > 0 ? (
            <Alert tone="warn" title="以下项目引用无法解析">
              <span>{unresolved.join('、')}</span>
              <span className="alert-hint">
                系统不会因为 AI 写了一个项目名就自动创建项目。请先在「项目」页建立它们，
                然后用项目映射重新导入。
              </span>
            </Alert>
          ) : null}
        </Card>
      ) : null}

      <Card tight title="第三步：把上下文带回去" hint="到「项目」页生成，或直接用下面已有的包">
        {exports.length === 0 ? (
          <EmptyState kind="connected_no_data" title="还没有生成过上下文包">
            <span>选中一个项目 → 生成上下文包 → 复制 Markdown → 粘贴到目标客户端。</span>
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>生成时间</th>
                  <th>项目</th>
                  <th className="num">条目</th>
                  <th>状态</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {exports.map((e) => (
                  <tr key={e.id}>
                    <td className="tiny nowrap">{formatDateTime(e.createdAt)}</td>
                    <td className="tiny">{projects.find((p) => p.id === e.projectId)?.title ?? e.projectId}</td>
                    <td className="num">{e.itemCount}</td>
                    <td className="tiny">
                      {e.invalidatedAt ? <Badge tone="warn">已失效</Badge> : <Badge tone="ok">有效</Badge>}
                    </td>
                    <td>
                      <button
                        className="ghost small"
                        onClick={async () => {
                          try {
                            const detail = await api.get<{ markdown: string }>(`/api/context-exports/${e.id}`);
                            const ok = await copyText(detail.markdown);
                            toast(ok ? '已复制该上下文包。' : '复制失败，请手动复制。', ok ? 'ok' : 'warn');
                          } catch (err) {
                            toast(err instanceof Error ? err.message : String(err), 'danger');
                          }
                        }}
                      >
                        复制
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card tight title="这条路径做不到什么" hint="写清楚比含糊过去有用">
        <ul className="list-plain">
          <li>
            <strong>不能双向同步。</strong>本系统不写入、不复制 ChatGPT 的原生 Memory。原生「请记住」和外部
            「请生成候选记忆」在文案上必须分开，否则你会以为信息存进了另一个地方。
          </li>
          <li>
            <strong>手机和电脑之间没有天然共享的 localhost。</strong>可以在电脑网页端打开同一段聊天后复制，
            或自己选择传输方式。本版本不装同步服务、不开局域网端口。
          </li>
          <li>
            <strong>上传到 ChatGPT Projects 的文件是一份快照。</strong>它不会随着本地记忆库更新而更新，
            用完后需要按版本主动替换。
          </li>
          <li>
            <strong>远程 MCP / 应用接入尚未实现。</strong>那属于后续阶段，需要逐账户、逐客户端实际探测，
            不能从文档推断。
          </li>
        </ul>
        <div className="notice">
          最近一次操作：{' '}
          {exports.length > 0 && exports[0] ? formatRelative(exports[0].createdAt) : '还没有生成过上下文包'}
        </div>
      </Card>
    </div>
  );
}
