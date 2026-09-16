/**
 * 服务上下文：把「数据库 + 配置 + 时钟」打包传给各个服务。
 *
 * 时钟是一个函数而不是直接调 `Date.now()`：测试里需要把时间拨到额度重置之后
 * 来验证 U07（待刷新），或者拨到很久之后验证过期快照。没有可注入的时钟，
 * 这些用例就只能靠 sleep，既慢又不可靠。
 */

import type { AppConfig } from './config.js';
import type { DbConnection } from './db/database.js';

export interface ServiceContext {
  db: DbConnection;
  config: AppConfig;
  /** 实际使用的 SQLite 驱动名，会出现在自检与备份清单里。 */
  driver: string;
  now(): number;
  /** 审计记录里的操作者标识。本地单用户模式下就是这个人。 */
  actor: string;
}

export function createServiceContext(input: {
  db: DbConnection;
  config: AppConfig;
  driver: string;
  actor?: string;
  clock?: () => number;
}): ServiceContext {
  return {
    db: input.db,
    config: input.config,
    driver: input.driver,
    actor: input.actor ?? 'local-user',
    now: input.clock ?? (() => Date.now()),
  };
}

export function isoNow(ctx: ServiceContext): string {
  return new Date(ctx.now()).toISOString();
}
