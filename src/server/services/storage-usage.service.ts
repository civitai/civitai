import { dbRead, dbWrite } from '~/server/db/client';

export type StoragePublicStatus = 'public' | 'notPublic';

export type StorageUsageRow = {
  userId: number;
  kind: string;
  publicStatus: StoragePublicStatus;
  baseModel: string;
  /** First day of the upload month, `YYYY-MM-DD`. */
  month: string;
  fileCount: number;
  bytes: bigint;
};

/** Kinds the nightly job owns. The media job owns the rest, so neither deletes the other's rows. */
export const NIGHTLY_STORAGE_KINDS = ['model', 'training', 'attachment', 'model3d'] as const;
/** Written through from `Image.type`, so this must list every `MediaType` value. */
export const MEDIA_STORAGE_KINDS = ['image', 'video', 'audio'] as const;

export const USER_ID_RANGE_WIDTH = 100_000;

// The prod replica cancels any statement that conflicts with replay after max_standby_streaming_delay
// (30 s). A heavy creator's full image sum measured 18.8–42.5 s cold, so it is read in keyset chunks:
// 50k rows measured 2.8–3.2 s cold.
export const MEDIA_CHUNK_ROWS = 50_000;
// 20M images. Hitting it throws rather than writing a total that silently stops partway.
export const MAX_MEDIA_CHUNKS = 400;

// One creator per tick, and a lease longer than the job's 10-minute lock, so a slow run cannot be
// reclaimed by the next tick while it is still scanning.
export const MEDIA_CLAIM_LIMIT = 1;
export const MEDIA_LEASE_MINUTES = 15;

// Bound as a parameter: inline, its backslash would have to survive both the JS template and the SQL
// string literal, which treat it differently. 13 digits (~9 TB) keeps a forged size from overflowing.
export const MEDIA_SIZE_PATTERN = String.raw`^[0-9]{1,13}(\.[0-9]+)?$`;

const bucketKey = (r: Pick<StorageUsageRow, 'kind' | 'publicStatus' | 'baseModel' | 'month'>) =>
  `${r.kind}\u0000${r.publicStatus}\u0000${r.baseModel}\u0000${r.month}`;

export type MediaChunk = {
  /** Image rows the chunk covered; fewer than the limit means it was the last one. */
  rows: number;
  lastId: number;
  buckets: Omit<StorageUsageRow, 'userId'>[];
};

export type FetchMediaChunk = (
  userId: number,
  afterId: number,
  limit: number
) => Promise<MediaChunk>;

export function mergeBuckets(
  acc: Map<string, StorageUsageRow>,
  userId: number,
  buckets: Omit<StorageUsageRow, 'userId'>[]
) {
  for (const b of buckets) {
    const key = bucketKey(b);
    const existing = acc.get(key);
    if (existing) {
      existing.fileCount += b.fileCount;
      existing.bytes += b.bytes;
    } else {
      acc.set(key, { ...b, userId });
    }
  }
}

export async function sumUserMedia(
  userId: number,
  fetchChunk: FetchMediaChunk = fetchMediaChunk,
  { chunkRows = MEDIA_CHUNK_ROWS, maxChunks = MAX_MEDIA_CHUNKS } = {}
): Promise<StorageUsageRow[]> {
  const acc = new Map<string, StorageUsageRow>();
  let afterId = 0;
  for (let i = 0; i < maxChunks; i++) {
    const chunk = await fetchChunk(userId, afterId, chunkRows);
    mergeBuckets(acc, userId, chunk.buckets);
    if (chunk.rows < chunkRows) return [...acc.values()];
    afterId = chunk.lastId;
  }
  throw new Error(
    `storage-usage: user ${userId} has more than ${maxChunks * chunkRows} media rows`
  );
}

export type RawMediaBucket = {
  kind: string;
  publicStatus: StoragePublicStatus;
  month: string;
  fileCount: number;
  /** numeric as text: a per-chunk sum can exceed what a JS number holds exactly. */
  bytes: string;
  /** Window totals over the whole chunk, identical on every row. */
  chunkRows: number;
  lastId: number;
};

export function toMediaChunk(rows: RawMediaBucket[], afterId: number): MediaChunk {
  return {
    rows: rows[0]?.chunkRows ?? 0,
    lastId: rows[0]?.lastId ?? afterId,
    buckets: rows.map((r) => ({
      kind: r.kind,
      publicStatus: r.publicStatus,
      baseModel: '',
      month: r.month,
      fileCount: r.fileCount,
      bytes: BigInt(r.bytes),
    })),
  };
}

export const fetchMediaChunk: FetchMediaChunk = async (userId, afterId, limit) => {
  const rows = await dbRead.$queryRaw<RawMediaBucket[]>`
    WITH c AS (
      SELECT i.id, i.type, i."createdAt", i."postId", i."tosViolation", i.ingestion,
        i.metadata->>'size' AS size
      FROM "Image" i
      WHERE i."userId" = ${userId} AND i.id > ${afterId}
      ORDER BY i.id
      LIMIT ${limit}
    )
    SELECT
      c.type::text AS kind,
      CASE
        WHEN p."publishedAt" IS NOT NULL AND p."publishedAt" <= now()
          AND NOT c."tosViolation" AND c.ingestion <> 'Blocked' THEN 'public'
        ELSE 'notPublic'
      END AS "publicStatus",
      to_char(date_trunc('month', c."createdAt"), 'YYYY-MM-DD') AS month,
      count(*)::int AS "fileCount",
      round(coalesce(sum(CASE WHEN c.size ~ ${MEDIA_SIZE_PATTERN} THEN c.size::numeric END), 0))::text AS bytes,
      (sum(count(*)) OVER ())::int AS "chunkRows",
      (max(max(c.id)) OVER ())::int AS "lastId"
    FROM c
    LEFT JOIN "Post" p ON p.id = c."postId"
    GROUP BY 1, 2, 3
  `;
  return toMediaChunk(rows, afterId);
};

export async function fetchNightlyUsage(lo: number, hi: number): Promise<StorageUsageRow[]> {
  return dbRead.$queryRaw<StorageUsageRow[]>`
    SELECT
      m."userId",
      CASE WHEN mf.type = 'Training Data' THEN 'training' ELSE 'model' END AS kind,
      CASE
        WHEN m.status = 'Published' AND mv.status = 'Published' AND m.mode IS NULL
          AND m.availability <> 'Private' AND mv.availability <> 'Private' THEN 'public'
        ELSE 'notPublic'
      END AS "publicStatus",
      mv."baseModel",
      to_char(date_trunc('month', mf."createdAt"), 'YYYY-MM-DD') AS month,
      count(*)::int AS "fileCount",
      round(sum(mf."sizeKB")::numeric * 1024)::bigint AS bytes
    FROM "Model" m
    JOIN "ModelVersion" mv ON mv."modelId" = m.id
    JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id
    WHERE m."userId" >= ${lo} AND m."userId" < ${hi}
      AND m.status <> 'Deleted' AND NOT mf."dataPurged"
    GROUP BY 1, 2, 3, 4, 5

    UNION ALL

    SELECT
      m."userId",
      'model3d',
      CASE WHEN m.status = 'Published' AND m.availability <> 'Private' THEN 'public' ELSE 'notPublic' END,
      '',
      to_char(date_trunc('month', f."createdAt"), 'YYYY-MM-DD'),
      count(*)::int,
      round(sum(f."sizeKB")::numeric * 1024)::bigint
    FROM "Model3D" m
    JOIN "Model3DFile" f ON f."model3dId" = m.id
    WHERE m."userId" >= ${lo} AND m."userId" < ${hi}
      AND m.status <> 'Deleted' AND m."deletedAt" IS NULL
    GROUP BY 1, 3, 5

    UNION ALL

    SELECT
      o."userId",
      'attachment',
      o."publicStatus",
      '',
      to_char(date_trunc('month', f."createdAt"), 'YYYY-MM-DD'),
      count(*)::int,
      round(sum(f."sizeKB")::numeric * 1024)::bigint
    FROM (
      SELECT 'BountyEntry' AS "entityType", id, "userId", 'public' AS "publicStatus"
      FROM "BountyEntry" WHERE "userId" >= ${lo} AND "userId" < ${hi}
      UNION ALL
      SELECT 'Bounty', id, "userId", 'public'
      FROM "Bounty" WHERE "userId" >= ${lo} AND "userId" < ${hi}
      UNION ALL
      SELECT 'Article', id, "userId",
        CASE WHEN status = 'Published' AND NOT "tosViolation" THEN 'public' ELSE 'notPublic' END
      FROM "Article" WHERE "userId" >= ${lo} AND "userId" < ${hi}
    ) o
    JOIN "File" f ON f."entityType" = o."entityType" AND f."entityId" = o.id
    GROUP BY 1, 3, 5
  `;
}

function toArrays(rows: StorageUsageRow[]) {
  return {
    userIds: rows.map((r) => r.userId),
    kinds: rows.map((r) => r.kind),
    statuses: rows.map((r) => r.publicStatus),
    baseModels: rows.map((r) => r.baseModel),
    months: rows.map((r) => r.month),
    counts: rows.map((r) => r.fileCount),
    bytes: rows.map((r) => r.bytes.toString()),
  };
}

/**
 * Replaces the nightly kinds for users in [lo, hi) and snapshots any public total that moved.
 *
 * Unchanged rows are filtered out before the upsert: ON CONFLICT DO UPDATE locks every row it
 * conflicts with even when its WHERE rejects the update, which would log a lock for every row nightly.
 */
export async function writeNightlyUsage(lo: number, hi: number, rows: StorageUsageRow[]) {
  const a = toArrays(rows);
  await dbWrite.$transaction([
    dbWrite.$executeRaw`
      WITH incoming AS (
        SELECT * FROM unnest(
          ${a.userIds}::int[], ${a.kinds}::text[], ${a.statuses}::text[], ${a.baseModels}::text[],
          ${a.months}::date[], ${a.counts}::int[], ${a.bytes}::bigint[]
        ) AS t("userId", kind, "publicStatus", "baseModel", month, "fileCount", bytes)
      )
      INSERT INTO "UserStorageUsage" ("userId", kind, "publicStatus", "baseModel", month, "fileCount", bytes)
      SELECT i.* FROM incoming i
      WHERE NOT EXISTS (
        SELECT 1 FROM "UserStorageUsage" u
        WHERE u."userId" = i."userId" AND u.kind = i.kind AND u."publicStatus" = i."publicStatus"
          AND u."baseModel" = i."baseModel" AND u.month = i.month
          AND u."fileCount" = i."fileCount" AND u.bytes = i.bytes
      )
      ON CONFLICT ("userId", kind, "publicStatus", "baseModel", month) DO UPDATE
        SET "fileCount" = EXCLUDED."fileCount", bytes = EXCLUDED.bytes,
          "computedAt" = timezone('UTC', now())
    `,
    dbWrite.$executeRaw`
      DELETE FROM "UserStorageUsage" u
      WHERE u."userId" >= ${lo} AND u."userId" < ${hi}
        AND u.kind = ANY(${[...NIGHTLY_STORAGE_KINDS]}::text[])
        AND (u."userId", u.kind, u."publicStatus", u."baseModel", u.month) NOT IN (
          SELECT * FROM unnest(
            ${a.userIds}::int[], ${a.kinds}::text[], ${a.statuses}::text[], ${a.baseModels}::text[],
            ${a.months}::date[]
          )
        )
    `,
    dbWrite.$executeRaw`
      DELETE FROM "UserStorageUsage" u
      WHERE u."userId" >= ${lo} AND u."userId" < ${hi}
        AND NOT EXISTS (SELECT 1 FROM "User" x WHERE x.id = u."userId")
    `,
    snapshotRange(lo, hi),
  ]);
}

/**
 * One row per creator per kind on the days its public total changes, including a drop to zero, so the
 * history is complete from launch without a row per creator per day.
 */
function snapshotRange(lo: number, hi: number) {
  return dbWrite.$executeRaw`
    WITH cur AS (
      SELECT u."userId", u.kind, sum(u."fileCount")::int AS "fileCount", sum(u.bytes)::bigint AS bytes
      FROM "UserStorageUsage" u
      WHERE u."userId" >= ${lo} AND u."userId" < ${hi} AND u."publicStatus" = 'public'
      GROUP BY 1, 2
    ),
    last AS (
      SELECT DISTINCT ON (s."userId", s.kind) s."userId", s.kind, s."fileCount", s.bytes
      FROM "UserStorageSnapshot" s
      WHERE s."userId" >= ${lo} AND s."userId" < ${hi}
      ORDER BY s."userId", s.kind, s.date DESC
    )
    INSERT INTO "UserStorageSnapshot" ("userId", date, kind, "fileCount", bytes)
    SELECT coalesce(c."userId", l."userId"), timezone('UTC', now())::date, coalesce(c.kind, l.kind),
      coalesce(c."fileCount", 0), coalesce(c.bytes, 0)
    FROM cur c
    FULL JOIN last l ON l."userId" = c."userId" AND l.kind = c.kind
    WHERE (l."userId" IS NULL AND c."userId" IS NOT NULL)
      OR (l."userId" IS NOT NULL
        AND (coalesce(c."fileCount", 0) <> l."fileCount" OR coalesce(c.bytes, 0) <> l.bytes))
    ON CONFLICT ("userId", date, kind) DO UPDATE
      SET "fileCount" = EXCLUDED."fileCount", bytes = EXCLUDED.bytes
  `;
}

export async function getMaxUserId() {
  const [row] = await dbRead.$queryRaw<{ max: number | null }[]>`SELECT max(id) AS max FROM "User"`;
  return row?.max ?? 0;
}

/**
 * Claims pending media rollups. A row is pending when it was requested after its last completion; one
 * claimed within the lease is in flight and skipped, and one older than that is a dead run.
 */
export async function claimMediaRollups(limit = MEDIA_CLAIM_LIMIT) {
  const rows = await dbWrite.$queryRaw<{ userId: number }[]>`
    UPDATE "UserStorageRollup" SET "imagesStartedAt" = timezone('UTC', now())
    WHERE "userId" IN (
      SELECT "userId" FROM "UserStorageRollup"
      WHERE ("imagesComputedAt" IS NULL OR "imagesRequestedAt" > "imagesComputedAt")
        AND "imagesRequestedAt" IS NOT NULL
        AND ("imagesStartedAt" IS NULL OR "imagesStartedAt" < timezone('UTC', now()) - make_interval(mins => ${MEDIA_LEASE_MINUTES}))
      ORDER BY "imagesRequestedAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "userId"
  `;
  return rows.map((r) => r.userId);
}

export async function writeMediaUsage(userId: number, rows: StorageUsageRow[]) {
  const a = toArrays(rows);
  await dbWrite.$transaction([
    dbWrite.$executeRaw`
      DELETE FROM "UserStorageUsage"
      WHERE "userId" = ${userId} AND kind = ANY(${[...MEDIA_STORAGE_KINDS]}::text[])
    `,
    dbWrite.$executeRaw`
      INSERT INTO "UserStorageUsage" ("userId", kind, "publicStatus", "baseModel", month, "fileCount", bytes)
      SELECT * FROM unnest(
        ${a.userIds}::int[], ${a.kinds}::text[], ${a.statuses}::text[], ${a.baseModels}::text[],
        ${a.months}::date[], ${a.counts}::int[], ${a.bytes}::bigint[]
      )
      ON CONFLICT ("userId", kind, "publicStatus", "baseModel", month) DO UPDATE
        SET "fileCount" = EXCLUDED."fileCount", bytes = EXCLUDED.bytes,
          "computedAt" = timezone('UTC', now())
    `,
    dbWrite.$executeRaw`
      UPDATE "UserStorageRollup" SET "imagesComputedAt" = timezone('UTC', now()) WHERE "userId" = ${userId}
    `,
  ]);
}

type Log = (message: string, error: unknown) => void;
const logError: Log = (message, error) => console.error(message, error);

/** Walks every user-id range; one failing range is logged and skipped rather than ending the night. */
export async function runNightlyStorageUsage({
  maxUserId = getMaxUserId,
  fetchRange = fetchNightlyUsage,
  writeRange = writeNightlyUsage,
  log = logError,
} = {}) {
  const max = await maxUserId();
  let ranges = 0;
  let rows = 0;
  const failed: number[] = [];
  for (let lo = 0; lo <= max; lo += USER_ID_RANGE_WIDTH) {
    const hi = lo + USER_ID_RANGE_WIDTH;
    ranges++;
    try {
      const usage = await fetchRange(lo, hi);
      await writeRange(lo, hi, usage);
      rows += usage.length;
    } catch (e) {
      failed.push(lo);
      log(`storage-usage-nightly: range [${lo}, ${hi}) failed`, e);
    }
  }
  if (failed.length) {
    throw new Error(`storage-usage-nightly: ${failed.length} of ${ranges} range(s) failed`);
  }
  return { ranges, rows };
}

export async function runMediaStorageUsage({
  claim = claimMediaRollups,
  sum = (userId: number) => sumUserMedia(userId),
  write = writeMediaUsage,
  log = logError,
} = {}) {
  const userIds = await claim();
  const failed: number[] = [];
  for (const userId of userIds) {
    try {
      await write(userId, await sum(userId));
    } catch (e) {
      failed.push(userId);
      log(`storage-usage-media: user ${userId} failed`, e);
    }
  }
  if (failed.length) throw new Error(`storage-usage-media: ${failed.length} rollup(s) failed`);
  return { processed: userIds.length };
}
