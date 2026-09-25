import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from '$lib/server/db';
import { createCache } from '$lib/server/cache';
import { getLogger } from '$lib/server/logger';
import {
  mediaStatus,
  needsMediaRefresh,
  type MediaStatus,
  type StorageRollupState,
  type StorageRow,
} from '$lib/analytics/storage';

// The rollup tables arrive by a hand-applied migration. Until they exist the page says so rather than
// 500ing, and rather than reading as a creator with nothing uploaded.
export const isMissingRelation = (e: unknown) => (e as { code?: string } | null)?.code === '42P01';

export const BY_MODEL_LIMIT = 500;

export type StorageUsage = {
  ready: boolean;
  state: StorageRollupState | null;
  rows: StorageRow[];
};

type UsageReadRow = StorageRollupState & {
  kind: string | null;
  publicStatus: string;
  baseModel: string;
  month: string;
  fileCount: number;
  bytes: number;
};

export function toStorageUsage(rows: UsageReadRow[]): StorageUsage {
  const first = rows[0];
  return {
    ready: true,
    state:
      first && (first.requestedAt || first.computedAt)
        ? { requestedAt: first.requestedAt, computedAt: first.computedAt }
        : null,
    rows: rows
      .filter((r) => r.kind !== null)
      .map(({ kind, publicStatus, baseModel, month, fileCount, bytes }) => ({
        kind: kind as string,
        publicStatus,
        baseModel,
        month,
        fileCount,
        bytes,
      })),
  };
}

// State and rows come from one statement, so they are one replica snapshot: read separately, a lagging
// replica could pair a new computedAt with the previous run's rows.
export async function getStorageUsage(userId: number): Promise<StorageUsage> {
  try {
    const { rows } = await sql<UsageReadRow>`
      SELECT
        to_char(r."imagesRequestedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "requestedAt",
        to_char(r."imagesComputedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "computedAt",
        u.kind, u."publicStatus", u."baseModel", to_char(u.month, 'YYYY-MM-DD') AS month,
        u."fileCount", u.bytes::float8 AS bytes
      FROM (SELECT ${userId}::int AS "userId") k
      LEFT JOIN "UserStorageRollup" r ON r."userId" = k."userId"
      LEFT JOIN "UserStorageUsage" u ON u."userId" = k."userId"
    `.execute(dbRead);
    return toStorageUsage(rows);
  } catch (e) {
    if (isMissingRelation(e)) return { ready: false, state: null, rows: [] };
    throw e;
  }
}

/**
 * Queues this creator's image/video rollup. The SQL repeats the JS staleness rule, including leaving an
 * already-queued request alone, so a second tab cannot push the creator to the back of the queue.
 */
export async function requestMediaRollup(userId: number) {
  try {
    await sql`
      INSERT INTO "UserStorageRollup" ("userId", "imagesRequestedAt")
      VALUES (${userId}, timezone('UTC', now()))
      ON CONFLICT ("userId") DO UPDATE SET "imagesRequestedAt" = timezone('UTC', now())
      WHERE ("UserStorageRollup"."imagesComputedAt" IS NULL AND "UserStorageRollup"."imagesRequestedAt" IS NULL)
        OR ("UserStorageRollup"."imagesComputedAt" < timezone('UTC', now()) - interval '24 hours'
          AND "UserStorageRollup"."imagesRequestedAt" <= "UserStorageRollup"."imagesComputedAt")
    `.execute(dbWrite);
  } catch (e) {
    if (isMissingRelation(e)) return;
    getLogger()
      .logToAxiom({ name: 'storage-rollup-request-failed', userId, error: String(e) })
      .catch(() => undefined);
  }
}

/** Reads the rollup and, when it is missing or stale, asks for a media refresh without waiting on it. */
export async function loadStorageUsage(
  userId: number
): Promise<StorageUsage & { media: MediaStatus }> {
  const usage = await getStorageUsage(userId);
  const queued = usage.ready && needsMediaRefresh(usage.state);
  if (queued) void requestMediaRollup(userId);
  const media: MediaStatus = queued
    ? usage.state?.computedAt
      ? 'refreshing'
      : 'first'
    : mediaStatus(usage.state);
  return { ...usage, media };
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
  /** Every model the creator has files on, before the limit. */
  totalModels: number;
};

async function fetchByModel(userId: number): Promise<StorageModelRow[]> {
  const { rows } = await sql<StorageModelRow>`
    SELECT m.id AS "modelId", m.name, m.status::text AS status, m.nsfw, m."nsfwLevel",
      count(DISTINCT mv.id)::int AS versions, count(mf.id)::int AS files,
      round(sum(mf."sizeKB")::numeric * 1024)::float8 AS bytes,
      (count(*) OVER ())::int AS "totalModels"
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
