import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';

import { isUndefinedTable, type CoocSql } from '~/server/services/resource-intent-cooc/store';

/**
 * The weekly tag-index job's heartbeats, persisted in `KeyValue` as epoch milliseconds (the
 * co-occurrence retention heartbeat's encoding), so they survive pod restarts and are the same on
 * every pod; `~/server/prom/resource-intent-tags.metrics` exports them. The build records its last
 * success; retention, which the same job runs after every build attempt, its last success. A failed
 * run, or one that dies with its pod, writes nothing, so a stale success is the signal.
 */
export const TAG_INDEX_HEARTBEAT_KEYS = {
  buildSuccess: 'job:build-resource-intent-tag-index:last-success',
  retentionSuccess: 'job:resource-intent-tag-index-retention:last-success',
} as const;
export type TagIndexHeartbeat = keyof typeof TAG_INDEX_HEARTBEAT_KEYS;

export type TagIndexHeartbeatStore = Pick<PrismaClient, 'keyValue'>;

/** A stored heartbeat value as a date; anything but a positive finite number is not one. */
function heartbeatDate(value: unknown): Date | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value) : null;
}

export async function readTagIndexHeartbeats(
  db: TagIndexHeartbeatStore
): Promise<Record<TagIndexHeartbeat, Date | null>> {
  const rows = await db.keyValue.findMany({
    where: { key: { in: Object.values(TAG_INDEX_HEARTBEAT_KEYS) } },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    buildSuccess: heartbeatDate(byKey.get(TAG_INDEX_HEARTBEAT_KEYS.buildSuccess)),
    retentionSuccess: heartbeatDate(byKey.get(TAG_INDEX_HEARTBEAT_KEYS.retentionSuccess)),
  };
}

export async function writeTagIndexHeartbeat(
  db: TagIndexHeartbeatStore,
  which: TagIndexHeartbeat,
  at: Date
): Promise<void> {
  const key = TAG_INDEX_HEARTBEAT_KEYS[which];
  const value = at.getTime();
  await db.keyValue.upsert({ where: { key }, create: { key, value }, update: { value } });
}

/**
 * The newest ready snapshot's `createdAt` per spec hash (the database's clock): what an alert on "no
 * ready snapshot newer than 8 days" reads. A missing table reads as no rows.
 */
export async function readNewestReadyCreatedAt(
  sql: CoocSql
): Promise<{ specHash: string; createdAt: Date }[]> {
  try {
    return await sql.query<{ specHash: string; createdAt: Date }>(Prisma.sql`
      SELECT "specHash", max("createdAt") AS "createdAt"
      FROM "ResourceIntentTagIndexSnapshot"
      WHERE "status" = 'ready'
      GROUP BY "specHash"`);
  } catch (e) {
    if (isUndefinedTable(e)) return [];
    throw e;
  }
}

export type TagIndexJobResult<B, R> = {
  build: B;
  retention: R | { error: string };
};

/**
 * One run of the weekly job: the build, its success heartbeat if it succeeded, then retention whatever
 * the build did (a failed build is what leaves an unreferenced upload behind), then retention's
 * heartbeat if it succeeded. A failed build is rethrown after retention ran, so the job still counts
 * as failed; a retention failure is returned, not thrown, and its stale heartbeat reports it. A
 * failure to write the build-success heartbeat is rethrown too, last.
 */
export async function runTagIndexJob<B, R>(deps: {
  build: () => Promise<B>;
  retention: () => Promise<R>;
  kv: TagIndexHeartbeatStore;
  now: () => Date;
}): Promise<TagIndexJobResult<B, R>> {
  const built = await deps.build().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
  let heartbeatError: unknown = null;
  if (built.ok)
    await writeTagIndexHeartbeat(deps.kv, 'buildSuccess', deps.now()).catch((e: unknown) => {
      heartbeatError = e;
    });

  let retention: R | { error: string };
  try {
    retention = await deps.retention();
    await writeTagIndexHeartbeat(deps.kv, 'retentionSuccess', deps.now());
  } catch (e) {
    retention = { error: e instanceof Error ? e.message : String(e) };
  }

  if (!built.ok) throw built.error;
  if (heartbeatError) throw heartbeatError;
  return { build: built.value, retention };
}
