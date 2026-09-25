import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from '$lib/server/db';
import { createCache } from '$lib/server/cache';
import { getLogger } from '$lib/server/logger';
import type { StorageRollupState, StorageRow } from '$lib/analytics/storage';

// The rollup tables arrive by a hand-applied migration. Until they exist the page says so rather than
// 500ing, and rather than reading as a creator with nothing uploaded.
export const isMissingRelation = (e: unknown) => (e as { code?: string } | null)?.code === '42P01';

export const BY_MODEL_LIMIT = 500;

async function fetchRollupState(userId: number): Promise<StorageRollupState | null> {
  const { rows } = await sql<StorageRollupState>`
    SELECT
      to_char("imagesRequestedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "requestedAt",
      to_char("imagesComputedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "computedAt"
    FROM "UserStorageRollup" WHERE "userId" = ${userId}
  `.execute(dbRead);
  return rows[0] ?? null;
}

async function fetchUsageRows(userId: number): Promise<StorageRow[]> {
  const { rows } = await sql<StorageRow>`
    SELECT kind, "publicStatus", "baseModel", to_char(month, 'YYYY-MM-DD') AS month,
      "fileCount", bytes::float8 AS bytes
    FROM "UserStorageUsage" WHERE "userId" = ${userId}
  `.execute(dbRead);
  return rows;
}

// `computedAt` is part of the key, so a finished image rollup is visible on the next load instead of
// after the TTL. The nightly model-file half can lag by up to the TTL.
const usageCache = createCache({
  name: 'storage:usage:v1',
  fetch: ({ userId }: { userId: number; computedAt: string }) => fetchUsageRows(userId),
  ttlSeconds: 3600,
});

export type StorageUsage = {
  ready: boolean;
  state: StorageRollupState | null;
  rows: StorageRow[];
};

export async function getStorageUsage(userId: number): Promise<StorageUsage> {
  try {
    const state = await fetchRollupState(userId);
    const rows = await usageCache.get({ userId, computedAt: state?.computedAt ?? 'never' });
    return { ready: true, state, rows };
  } catch (e) {
    if (isMissingRelation(e)) return { ready: false, state: null, rows: [] };
    throw e;
  }
}

/** Queues this creator's image/video rollup. The SQL repeats the staleness rule so a race cannot requeue a fresh one. */
export async function requestMediaRollup(userId: number) {
  try {
    await sql`
      INSERT INTO "UserStorageRollup" ("userId", "imagesRequestedAt") VALUES (${userId}, now())
      ON CONFLICT ("userId") DO UPDATE SET "imagesRequestedAt" = now()
      WHERE ("UserStorageRollup"."imagesComputedAt" IS NULL AND "UserStorageRollup"."imagesRequestedAt" IS NULL)
        OR "UserStorageRollup"."imagesComputedAt" < now() - interval '24 hours'
    `.execute(dbWrite);
  } catch (e) {
    if (isMissingRelation(e)) return;
    getLogger()
      .logToAxiom({ name: 'storage-rollup-request-failed', userId, error: String(e) })
      .catch(() => undefined);
  }
}

export type StorageModelRow = {
  modelId: number;
  name: string;
  status: string;
  nsfw: boolean;
  nsfwLevel: number;
  versions: number;
  files: number;
  bytes: number;
};

async function fetchByModel(userId: number): Promise<StorageModelRow[]> {
  const { rows } = await sql<StorageModelRow>`
    SELECT m.id AS "modelId", m.name, m.status::text AS status, m.nsfw, m."nsfwLevel",
      count(DISTINCT mv.id)::int AS versions, count(mf.id)::int AS files,
      round(sum(mf."sizeKB")::numeric * 1024)::float8 AS bytes
    FROM "Model" m
    JOIN "ModelVersion" mv ON mv."modelId" = m.id
    JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id
    WHERE m."userId" = ${userId} AND m.status <> 'Deleted' AND NOT mf."dataPurged"
    GROUP BY m.id
    ORDER BY bytes DESC
    LIMIT ${BY_MODEL_LIMIT}
  `.execute(dbRead);
  return rows;
}

export const getStorageByModel = createCache({
  name: 'storage:by-model:v1',
  fetch: ({ userId }: { userId: number }) => fetchByModel(userId),
  ttlSeconds: 3600,
}).get;
