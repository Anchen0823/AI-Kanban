import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpClientConfigs, MCP_TOKEN_PLACEHOLDER } from '../src/mcp-config.js';

test('MCP 配置保留含空格、反斜杠与引号的路径，使用真实 API 端口', () => {
  const launch = {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['D:\\projects\\AI "work"\\apps\\mcp\\dist\\index.js'],
    apiUrl: 'http://127.0.0.1:18787',
  };
  const result = buildMcpClientConfigs(launch);
  const json = JSON.parse(result.cursor).mcpServers.ai_control_center;
  assert.equal(json.type, 'stdio');
  assert.equal(json.command, launch.command);
  assert.deepEqual(json.args, launch.args);
  assert.equal(json.env.AICC_API_URL, launch.apiUrl);
  assert.equal(json.env.AICC_TOKEN, MCP_TOKEN_PLACEHOLDER);
  // This basic-string subset is also JSON-decodable: round-trip the emitted TOML values.
  const tomlValues = result.codex.split('\n').filter((line) => line.includes(' = '));
  const decoded = Object.fromEntries(tomlValues.map((line) => {
    const at = line.indexOf(' = ');
    return [line.slice(0, at), JSON.parse(line.slice(at + 3))];
  }));
  assert.equal(decoded.command, launch.command);
  assert.deepEqual(decoded.args, launch.args);
  assert.equal(decoded.AICC_API_URL, launch.apiUrl);
});

test('MCP 凭据作为字面字符串转义，不产生额外 TOML 字段或 JSON 结构', () => {
  const token = 'fake-token"\ncommand = "other"\u007f';
  const result = buildMcpClientConfigs({ command: 'node', args: ['index.js'], apiUrl: 'http://[::1]:8788' }, token);
  const tokenLine = result.codex.split('\n').find((line) => line.startsWith('AICC_TOKEN = '))!;
  assert.equal(JSON.parse(tokenLine.slice('AICC_TOKEN = '.length)), token);
  assert.equal(JSON.parse(result.cursor).mcpServers.ai_control_center.env.AICC_TOKEN, token);
  assert.equal(result.codex.split('\n').filter((line) => line.startsWith('command = ')).length, 1);
  assert.ok(!result.codex.includes('\u007f'));
});
