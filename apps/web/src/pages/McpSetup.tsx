import { useEffect, useState, type ReactNode } from 'react';
import { buildMcpClientConfigs, type McpLaunchConfig } from '@aicc/core';
import { api } from '../api.js';
import type { PageProps } from '../App.js';
import { Alert, Card, copyText } from '../ui.js';

interface McpSetupInfo extends McpLaunchConfig {
  built: boolean;
  note: string;
}

/** The token stays in the credential modal's memory and is never posted back or persisted. */
export function McpSetup({ token, scopes, toast }: { token?: string; scopes?: string[]; toast: PageProps['toast'] }): ReactNode {
  const [setup, setSetup] = useState<McpSetupInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<'codex' | 'cursor'>('codex');

  useEffect(() => {
    let current = true;
    void api.get<McpSetupInfo>('/api/mcp/setup').then(
      (value) => { if (current) setSetup(value); },
      (err: unknown) => { if (current) setError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { current = false; };
  }, []);

  const config = setup ? buildMcpClientConfigs(setup, token)[client] : '';

  return (
    <Card tight title="连接本地 MCP" hint="配置使用本机 Node、服务入口的完整路径和当前工作台端口">
      {error ? <Alert tone="danger" title="无法读取接入配置">{error}</Alert> : !setup ? (
        <div className="muted">正在读取接入配置…</div>
      ) : (
        <div className="stack">
          {!setup.built ? <Alert tone="warn" title="MCP 尚未构建">请在项目根目录运行 npm run build，再刷新页面。</Alert> : null}
          <div className="pill-group" aria-label="MCP 客户端配置">
            <button type="button" className={`tag-btn${client === 'codex' ? ' active' : ''}`} onClick={() => setClient('codex')}>Codex</button>
            <button type="button" className={`tag-btn${client === 'cursor' ? ' active' : ''}`} onClick={() => setClient('cursor')}>Cursor</button>
          </div>
          <p className="muted small-text">
            {client === 'codex'
              ? '将下方配置合并到个人 ~/.codex/config.toml；已有同名表时更新该表，避免重复添加。'
              : '将 ai_control_center 合并到个人 ~/.cursor/mcp.json 的 mcpServers 中，保留已有服务。'}
            {token ? ' 此配置包含刚签发的凭据，请保存在个人配置中，不要提交到 Git。' : ' 请把 REPLACE_WITH_YOUR_AICC_TOKEN 替换为你保存的凭据；签发新凭据时会自动填入。'}
          </p>
          <label className="field">
            <span>{client === 'codex' ? 'Codex TOML 配置' : 'Cursor JSON 配置'}</span>
            <textarea className="mono" rows={10} readOnly value={config} spellCheck={false} />
          </label>
          <div className="row">
            <button type="button" className="ghost small" disabled={!setup.built} onClick={async () => {
              const copied = await copyText(config);
              toast(copied ? 'MCP 配置已复制。' : '复制失败，请手动选中配置复制。', copied ? 'ok' : 'warn');
            }}>复制 MCP 配置</button>
            <span className="tiny faint">{setup.apiUrl}</span>
          </div>
          <div className="small-text muted">
            保存后重载客户端，确认 ai_control_center 的工具可见。
            {scopes?.includes('memory_search')
              ? ' 调用 memory_search，核对是否能找到已批准的项目记忆。'
              : ' 请使用此凭据已授权的工具验证连接；未勾选的权限会被服务端拒绝。'}
            {' '}{setup.note}
          </div>
        </div>
      )}
    </Card>
  );
}
