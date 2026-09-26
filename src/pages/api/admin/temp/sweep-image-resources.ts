import { Prisma } from '@prisma/client';
import { chunk as chunkArray, uniq } from 'lodash-es';
import * as z from 'zod';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { imageResourcesCache } from '~/server/redis/caches';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { bustCacheTag } from '~/server/utils/cache-helpers';
import { sleep } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Cleans up orphaned and non-visible ImageResourceNew rows. Every removed row is written to
 * "_sweep_irn_20260925" by the same statement that deletes it, so the sweep can be reversed.
 *
 * GET /api/admin/temp/sweep-image-resources?token=<WEBHOOK_TOKEN>&tier=dangling|visibility|redrive
 *   &dryRun=true|false   (default true) counts only
 *   &start=<id>          inclusive cursor: a version id, or an image id for `redrive`
 *   &end=<id>            exclusive; version tiers only
 *   &chunk=<n>           version ids per chunk (default 100000 dangling, 2000 visibility)
 *   &rowCap=10000        most rows one statement may delete
 *   &sleepMs=1000        pause between statements
 *   &budgetMs=60000      stop and return a cursor before the gateway times out
 *   &since=&until=       `redrive` only: replays search and cache updates for rows captured then
 *
 * Resumable: feed `nextStart` back as `start` until it comes back null. A chunk cut short by the
 * budget resumes from its own start, which is safe because deleted rows are not selected again.
 */

const CAPTURE = Prisma.raw('"_sweep_irn_20260925"');
const ID_BATCH = 500;
const BUST_BATCH = 1000;

const schema = z.object({
  tier: z.enum(['dangling', 'visibility', 'redrive']),
  dryRun: booleanString().default(true),
  start: z.coerce.number().int().min(0).default(0),
  end: z.coerce.number().int().min(1).optional(),
  chunk: z.coerce.number().int().min(1).max(200_000).optional(),
  rowCap: z.coerce.number().int().min(1).max(50_000).default(10_000),
  sleepMs: z.coerce.number().int().min(0).max(60_000).default(1000),
  budgetMs: z.coerce.number().int().min(1000).max(120_000).default(60_000),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});

type Pair = { imageId: number; modelVersionId: number };
type Tiered = Pair & { tier: string };

const tierSql = Prisma.sql`CASE WHEN mv.availability = 'Private' OR m.availability = 'Private'
  THEN 'private' ELSE 'never_published' END`;

const versionInScope = Prisma.sql`(
  (mv.status = 'Draft' AND NOT EXISTS (
    SELECT 1 FROM "Post" pp WHERE pp."modelVersionId" = mv.id AND pp."publishedAt" IS NOT NULL))
  OR (mv.status = 'Published' AND m.status = 'Published'
      AND (mv.availability = 'Private' OR m.availability = 'Private'))
)`;

// Manual rows and rows listed in meta.civitaiResources only; post-derived and hash-detected rows
// are left alone. Judged for the image's owner.
const rowInScope = Prisma.sql`(
  i."userId" <> m."userId"
  AND NOT coalesce(u."isModerator", false)
  AND (
    (NOT irn.detected AND ps."modelVersionId" IS DISTINCT FROM irn."modelVersionId")
    OR (irn.detected
        AND jsonb_typeof(i.meta->'civitaiResources') = 'array'
        AND i.meta->'civitaiResources' @> jsonb_build_array(
          jsonb_build_object('modelVersionId', irn."modelVersionId")))
  )
  AND NOT ((${tierSql}) = 'private' AND EXISTS (
    SELECT 1 FROM "EntityAccess" ea
    WHERE ea."accessToId" = mv.id AND ea."accessToType" = 'ModelVersion'
      AND ea."accessorType" = 'User' AND ea."accessorId" = i."userId"))
)`;

function missingVersionIds(lo: number, hi: number) {
  return dbRead.$queryRaw<{ v: number }[]>`
    WITH RECURSIVE ids AS (
      (SELECT "modelVersionId" AS v FROM "ImageResourceNew"
       WHERE "modelVersionId" >= ${lo} ORDER BY 1 LIMIT 1)
      UNION ALL
      SELECT (SELECT "modelVersionId" FROM "ImageResourceNew"
              WHERE "modelVersionId" > ids.v ORDER BY 1 LIMIT 1)
      FROM ids WHERE ids.v < ${hi}
    )
    SELECT v FROM ids
    WHERE v IS NOT NULL AND v < ${hi}
      AND NOT EXISTS (SELECT 1 FROM "ModelVersion" mv WHERE mv.id = ids.v)
  `.then((rows) => rows.map((r) => r.v));
}

async function countDangling(ids: number[]) {
  const [row] = await dbRead.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "ImageResourceNew" WHERE "modelVersionId" = ANY(${ids}::int[])
  `;
  return row.n;
}

// The missing-version check is repeated on the primary, so an id created since the replica read
// is kept.
function deleteDangling(ids: number[], rowCap: number) {
  return dbWrite.$queryRaw<Pair[]>`
    WITH t AS (
      SELECT irn."imageId", irn."modelVersionId" FROM "ImageResourceNew" irn
      WHERE irn."modelVersionId" = ANY(${ids}::int[])
        AND NOT EXISTS (SELECT 1 FROM "ModelVersion" mv WHERE mv.id = irn."modelVersionId")
      LIMIT ${rowCap}
    ), d AS (
      DELETE FROM "ImageResourceNew" irn USING t
      WHERE irn."imageId" = t."imageId" AND irn."modelVersionId" = t."modelVersionId"
      RETURNING irn.*
    )
    INSERT INTO ${CAPTURE} ("imageId", "modelVersionId", "strength", "detected", "tier")
    SELECT "imageId", "modelVersionId", "strength", "detected", 'dangling' FROM d
    RETURNING "imageId", "modelVersionId"
  `;
}

function selectNonVisible(lo: number, hi: number) {
  return dbRead.$queryRaw<Tiered[]>`
    SELECT irn."imageId", irn."modelVersionId", ${tierSql} AS tier
    FROM "ModelVersion" mv
    JOIN "Model" m ON m.id = mv."modelId"
    JOIN "ImageResourceNew" irn ON irn."modelVersionId" = mv.id
    JOIN "Image" i ON i.id = irn."imageId"
    LEFT JOIN "User" u ON u.id = i."userId"
    LEFT JOIN "Post" ps ON ps.id = i."postId"
    WHERE mv.id >= ${lo} AND mv.id < ${hi}
      AND ${versionInScope}
      AND ${rowInScope}
  `;
}

// Selected on the replica; the rule is applied again here, on the primary, so a row whose version
// or owner changed since is kept.
function deleteNonVisible(pairs: Pair[]) {
  return dbWrite.$queryRaw<Tiered[]>`
    WITH p AS (
      SELECT * FROM unnest(
        ${pairs.map((x) => x.imageId)}::int[],
        ${pairs.map((x) => x.modelVersionId)}::int[]
      ) AS p("imageId", "modelVersionId")
    ), d AS (
      DELETE FROM "ImageResourceNew" irn
      USING p, "ModelVersion" mv, "Model" m, "Image" i
        LEFT JOIN "User" u ON u.id = i."userId"
        LEFT JOIN "Post" ps ON ps.id = i."postId"
      WHERE irn."imageId" = p."imageId" AND irn."modelVersionId" = p."modelVersionId"
        AND mv.id = irn."modelVersionId" AND m.id = mv."modelId" AND i.id = irn."imageId"
        AND ${versionInScope}
        AND ${rowInScope}
      RETURNING irn.*, ${tierSql} AS tier
    )
    INSERT INTO ${CAPTURE} ("imageId", "modelVersionId", "strength", "detected", "tier")
    SELECT "imageId", "modelVersionId", "strength", "detected", tier FROM d
    RETURNING "imageId", "modelVersionId", "tier"
  `;
}

function capturedSince(since: Date, until: Date, cursor: number, limit: number) {
  return dbRead.$queryRaw<Pair[]>`
    SELECT DISTINCT "imageId", "modelVersionId" FROM ${CAPTURE}
    WHERE "sweptAt" >= ${since} AND "sweptAt" < ${until} AND "imageId" >= ${cursor}
    ORDER BY "imageId", "modelVersionId"
    LIMIT ${limit}
  `;
}

async function afterRemoval(removed: Pair[]) {
  if (!removed.length) return;
  const imageIds = uniq(removed.map((r) => r.imageId));
  await queueImageSearchIndexUpdate({ ids: imageIds, action: SearchIndexUpdateQueueAction.Update });
  for (const batch of chunkArray(imageIds, BUST_BATCH)) await imageResourcesCache.bust(batch);
  await bustCacheTag(uniq(removed.map((r) => `images-modelVersion:${r.modelVersionId}`)));
}

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);
  const startedAt = Date.now();
  const outOfBudget = () => Date.now() - startedAt >= params.budgetMs;

  let rows = 0;
  const byTier: Record<string, number> = {};
  const imageIds = new Set<number>();
  let sideEffectFailures = 0;
  const failedImageIds: number[] = [];

  // Rows are gone by the time the updates run, so a failure is recorded rather than thrown: the
  // `redrive` tier replays it from the capture table.
  const settle = async (removed: Pair[]) => {
    try {
      await afterRemoval(removed);
    } catch {
      sideEffectFailures++;
      for (const r of removed) if (failedImageIds.length < 100) failedImageIds.push(r.imageId);
    }
  };
  const record = (tier: string, removed: Pair[]) => {
    rows += removed.length;
    byTier[tier] = (byTier[tier] ?? 0) + removed.length;
    removed.forEach((r) => imageIds.add(r.imageId));
  };
  const pause = () => (params.sleepMs ? sleep(params.sleepMs) : undefined);

  if (params.tier === 'redrive') {
    if (!params.since || !params.until)
      return res.status(400).json({ error: 'redrive needs since and until' });
    let cursor = params.start;
    let done = false;
    while (!done && !outOfBudget()) {
      const batch = await capturedSince(params.since, params.until, cursor, params.rowCap);
      if (!batch.length) {
        done = true;
        break;
      }
      record('redrive', batch);
      if (!params.dryRun) await settle(batch);
      // Resuming at the last image replays it again, which is harmless: the updates are idempotent,
      // and a batch cut inside an image must not skip that image's remaining pairs.
      if (batch.length < params.rowCap) done = true;
      else cursor = batch[batch.length - 1].imageId;
      await pause();
    }
    return res.status(200).json({
      tier: 'redrive',
      dryRun: params.dryRun,
      rows,
      images: imageIds.size,
      sideEffectFailures,
      failedImageIds,
      nextStart: done ? null : cursor,
    });
  }

  const chunk = params.chunk ?? (params.tier === 'dangling' ? 100_000 : 2_000);
  const [{ max }] =
    params.tier === 'dangling'
      ? await dbRead.$queryRaw<{ max: number | null }[]>`
          SELECT max("modelVersionId") AS max FROM "ImageResourceNew"
        `
      : await dbRead.$queryRaw<{ max: number | null }[]>`
          SELECT max(id) AS max FROM "ModelVersion"
        `;
  const end = params.end ?? (max ?? 0) + 1;

  let cursor = params.start;
  let interrupted = false;

  chunks: while (cursor < end) {
    if (outOfBudget()) {
      interrupted = true;
      break;
    }
    const hi = Math.min(cursor + chunk, end);

    if (params.tier === 'dangling') {
      const ids = await missingVersionIds(cursor, hi);
      for (const batch of chunkArray(ids, ID_BATCH)) {
        if (params.dryRun) {
          const n = await countDangling(batch);
          rows += n;
          byTier.dangling = (byTier.dangling ?? 0) + n;
          continue;
        }
        for (;;) {
          if (outOfBudget()) {
            interrupted = true;
            break chunks;
          }
          const removed = await deleteDangling(batch, params.rowCap);
          record('dangling', removed);
          await settle(removed);
          await pause();
          if (removed.length < params.rowCap) break;
        }
      }
    } else {
      const pairs = await selectNonVisible(cursor, hi);
      if (params.dryRun) {
        for (const p of pairs) record(p.tier, [p]);
      } else {
        for (const slice of chunkArray(pairs, params.rowCap)) {
          if (outOfBudget()) {
            interrupted = true;
            break chunks;
          }
          const removed = await deleteNonVisible(slice);
          for (const r of removed) record(r.tier, [r]);
          await settle(removed);
          await pause();
        }
      }
    }

    cursor = hi;
    if (params.tier === 'dangling' && cursor < end) {
      // Credited version ids above the ModelVersion range are sparse; skip the empty stretches.
      const [{ next }] = await dbRead.$queryRaw<{ next: number | null }[]>`
        SELECT min("modelVersionId") AS next FROM "ImageResourceNew" WHERE "modelVersionId" >= ${cursor}
      `;
      cursor = next ?? end;
    }
  }

  return res.status(200).json({
    tier: params.tier,
    dryRun: params.dryRun,
    rows,
    byTier,
    images: imageIds.size,
    sideEffectFailures,
    failedImageIds,
    nextStart: interrupted || cursor < end ? cursor : null,
  });
});
