import type { HistoryDashboard } from '@aicc/core';
import { tx } from '../db/database.js';
import type { ServiceContext } from '../service-context.js';
import type { WorkspaceScope } from '../db/repos/workspace.js';
import { historyTotal } from './history-total.js';
import { importedHistory } from './history-imported.js';
import { getCodexHistory } from './codex-history.js';
import { getWorkbuddyHistory } from './workbuddy-history.js';
import { getOpencodeHistory } from './opencode-history.js';
import { getMinimaxHistory } from './minimax-history.js';
import { getDeepseekHistory } from './deepseek-history.js';

/** Cache-only, synchronous read transaction: every panel observes the same SQLite snapshot. */
export function historyDashboard(ctx: ServiceContext, workspace: WorkspaceScope): HistoryDashboard {
  return tx<HistoryDashboard>(ctx.db, () => ({
    total: historyTotal(ctx, workspace),
    imported: importedHistory(ctx, workspace),
    local: workspace === 'real' ? {
      codex: getCodexHistory(ctx), workbuddy: getWorkbuddyHistory(ctx),
      opencode: getOpencodeHistory(ctx), minimax: getMinimaxHistory(ctx), deepseek: getDeepseekHistory(ctx),
    } : {} as HistoryDashboard['local'],
  }));
}
