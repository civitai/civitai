import type { PrismaClient } from '@prisma/client';

import { applyCoocRetention, type CoocSql } from './store';

/**
 * The retention sweep's heartbeat, persisted in `KeyValue` (in `getJobDate`'s encoding) so it
 * survives pod restarts; `~/server/prom/resource-intent-cooc.metrics` exports it.
 * Written only after a sweep succeeds, so a sweep that throws (including one that leaves an
 * overdue study row) or never runs leaves it stale for a staleness alert to catch.
 */
export const COOC_RETENTION_HEARTBEAT_KEY = 'job:resource-intent-cooc-retention:last-success';

export type CoocHeartbeatStore = Pick<PrismaClient, 'keyValue'>;

export async function readCoocRetentionHeartbeat(db: CoocHeartbeatStore): Promise<Date | null> {
  const row = await db.keyValue.findUnique({ where: { key: COOC_RETENTION_HEARTBEAT_KEY } });
  // KeyValue.value is untyped Json; anything but a positive finite number is not a heartbeat
  // (`Number(['1'])` is 1, so coercing instead of checking would invent a 1970 timestamp).
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
