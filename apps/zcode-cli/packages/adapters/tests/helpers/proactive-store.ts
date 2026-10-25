import {
  applySqliteSchemaMigration,
  ensureSqliteSchemaMigrationTable,
} from "@zcode/shared/sqlite-migrations";
import { DatabaseSync } from "node:sqlite";
import type { ProactiveStorePort } from "@zcode/contracts";
import { SQLITE_MIGRATIONS } from "../../src/storage/session-store/migrations.js";
import * as repo from "../../src/storage/session-store/repositories/proactive-orchestration.js";

/**
 * 测试助手：内存库上的 ProactiveStorePort 实现。
 *
 * 与 SqliteSessionStore 的委托同构——store 方法与仓储函数一一对应，
 * 这里直接复用仓储实现，避免测试里维护第二套语义。
 */
export function openProactiveStore(): { store: ProactiveStorePort; close(): void } {
  const db = new DatabaseSync(":memory:");
  db.exec("BEGIN IMMEDIATE");
  ensureSqliteSchemaMigrationTable(db);
  for (const migration of SQLITE_MIGRATIONS) applySqliteSchemaMigration(db, migration);
  db.exec("COMMIT");
  const store: ProactiveStorePort = {
    publishProactiveEvent: (input) => repo.publishProactiveEvent(db, input),
    claimProactiveTriggers: (input) => repo.claimProactiveTriggers(db, input),
    settleProactiveTrigger: (input) => repo.settleProactiveTrigger(db, input),
    proactiveDepthForSource: (sourceCommandId) =>
      repo.proactiveDepthForSource(db, sourceCommandId),
    rejectStaleGenerationTriggers: (input) =>
      repo.rejectStaleGenerationTriggers(db, input),
    cancelProactiveTriggersForSession: (input) =>
      repo.cancelProactiveTriggersForSession(db, input),
    proactiveTriggersForSession: (input) =>
      repo.proactiveTriggersForSession(db, input),
  };
  return { store, close: () => db.close() };
}
