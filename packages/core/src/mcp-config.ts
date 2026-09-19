/** Local stdio configuration. These strings are previews, never installation receipts. */
export interface McpLaunchConfig {
  command: string;
  args: string[];
  apiUrl: string;
}

export const MCP_TOKEN_PLACEHOLDER = 'REPLACE_WITH_YOUR_AICC_TOKEN';

// JSON and TOML basic strings share these escapes, except DEL must also be escaped in TOML.
function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, '\\u007f');
}

export function buildMcpClientConfigs(launch: McpLaunchConfig, token = MCP_TOKEN_PLACEHOLDER): {
  codex: string;
  cursor: string;
} {
  return {
    codex: [
      '[mcp_servers.ai_control_center]',
      `command = ${tomlString(launch.command)}`,
      `args = [${launch.args.map(tomlString).join(', ')}]`,
      '',
      '[mcp_servers.ai_control_center.env]',
      `AICC_API_URL = ${tomlString(launch.apiUrl)}`,
      `AICC_TOKEN = ${tomlString(token)}`,
      '',
    ].join('\n'),
    cursor: JSON.stringify({
      mcpServers: {
        ai_control_center: {
          type: 'stdio',
          command: launch.command,
          args: launch.args,
          env: { AICC_API_URL: launch.apiUrl, AICC_TOKEN: token },
        },
      },
    }, null, 2),
  };
}
