import type { PrismaClient } from '@prisma/client';

import { applyCoocRetention, type CoocSql } from './store';

/**
 * The retention sweep's heartbeat, persisted in `KeyValue` so it survives pod restarts and
 * rollouts; `~/server/prom/resource-intent-cooc.metrics` reads it back at scrape time. Written only
 * after a sweep succeeds, so a sweep that throws (including one that leaves an overdue study row)
 * or never runs shows up as a stale heartbeat to an alert outside this repo.
 */
export const COOC_RETENTION_HEARTBEAT_KEY = 'job:resource-intent-cooc-retention:last-success';

export type CoocHeartbeatStore = Pick<PrismaClient, 'keyValue'>;

export async function readCoocRetentionHeartbeat(db: CoocHeartbeatStore): Promise<Date | null> {
  const row = await db.keyValue.findUnique({ where: { key: COOC_RETENTION_HEARTBEAT_KEY } });
  const ms = row?.value;
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

/** One sweep: retention, then (only if it succeeded) the heartbeat. */
export async function runCoocRetentionSweep(
  sql: CoocSql,
  kv: CoocHeartbeatStore,
  now: Date
): Promise<{ deleted: number; tableMissing: boolean }> {
  const { deleted, tableMissing } = await applyCoocRetention(sql, now);
  const value = now.getTime();
  await kv.keyValue.upsert({
    where: { key: COOC_RETENTION_HEARTBEAT_KEY },
    create: { key: COOC_RETENTION_HEARTBEAT_KEY, value },
    update: { value },
  });
  return { deleted: deleted.length, tableMissing: !!tableMissing };
}
