/**
 * 工作区范围（设计稿 §8 / INV-16）。
 *
 * 设计稿的原话是「演示数据使用单独的 demo workspace 和持续可见的标识，
 * **不能污染真实总览**」。
 *
 * 这两件事是分开的：
 * - 「不能污染真实总览」→ 真实视图里一行 demo 都不出现；
 * - 「单独的 demo workspace」→ demo 数据要有地方**能被看到**。
 *
 * 早期实现只做了前半句（所有视图都排除 `is_demo = 1`），结果是用户
 * 点了「生成示例数据」之后什么都看不见，示例数据等于白生成。
 * 这里用一个三态范围把两件事都做到：真实视图、示例视图、以及不过滤的内部用途。
 */

export type WorkspaceScope = 'real' | 'demo' | 'all';

export function parseWorkspace(value: unknown): WorkspaceScope {
  return value === 'demo' || value === 'all' ? value : 'real';
}

/** 返回该范围对应的 `is_demo` 取值；`all` 时为 null（不过滤）。 */
export function demoFlag(scope: WorkspaceScope): number | null {
  if (scope === 'real') return 0;
  if (scope === 'demo') return 1;
  return null;
}

/** 构造可直接拼进 WHERE 的条件片段。`alias` 形如 `m.`。 */
export function workspaceClause(scope: WorkspaceScope, alias = ''): string {
  const flag = demoFlag(scope);
  return flag === null ? '1=1' : `${alias}is_demo = ${flag}`;
}

export function workspaceLabel(scope: WorkspaceScope): string {
  if (scope === 'demo') return '示例数据工作区';
  if (scope === 'all') return '全部数据（含示例）';
  return '真实数据工作区';
}
