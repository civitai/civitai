import { Prisma } from '@prisma/client';
import { uniq } from 'lodash-es';
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
 * Cleans up ImageResourceNew rows that credit a model version which no longer exists (`dangling`),
 * or one the image's owner cannot view (`visibility`): a never-published version or a private one
 * with no access grant, on the manual and meta-listed rows only. Every removed row is written to
 * "_sweep_irn_20260925" by the same statement that deletes it, so the sweep can be reversed.
 *
 * GET /api/admin/temp/sweep-image-resources?token=<WEBHOOK_TOKEN>&tier=dangling|visibility
 *   &dryRun=true|false   (default true) counts only
 *   &start=<versionId>   inclusive; default 0
 *   &end=<versionId>     exclusive; default one past the highest credited (dangling) or existing
 *                        (visibility) version id
 *   &chunk=<n>           version ids per chunk (default 100000 dangling, 2000 visibility)
 *   &sleepMs=1000        pause between chunks
 *   &budgetMs=60000      stop and return a cursor before the gateway times out
 *
 * Resumable: feed `nextStart` back as `start` until it comes back null.
 */

const CAPTURE = Prisma.raw('"_sweep_irn_20260925"');
const ID_BATCH = 500;

const schema = z.object({
  tier: z.enum(['dangling', 'visibility']),
  dryRun: booleanString().default(true),
  start: z.coerce.number().int().min(0).default(0),
  end: z.coerce.number().int().min(1).optional(),
  chunk: z.coerce.number().int().min(1).max(200_000).optional(),
  sleepMs: z.coerce.number().int().min(0).max(60_000).default(1000),
  budgetMs: z.coerce.number().int().min(1000).max(120_000).default(60_000),
});

type Pair = { imageId: number; modelVersionId: number; tier: string };
type Removed = { imageId: number; modelVersionId: number };

async function missingVersionIds(lo: number, hi: number) {
  const rows = await dbRead.$queryRaw<{ v: number }[]>`
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
  `;
  return rows.map((r) => r.v);
}

async function sweepDanglingIds(ids: number[], dryRun: boolean) {
  if (dryRun) {
    const [row] = await dbRead.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "ImageResourceNew" WHERE "modelVersionId" = ANY(${ids}::int[])
    `;
    return { count: row.n, removed: [] as Removed[] };
  }
  // The version is re-checked on the primary, so an id created since the replica read is kept.
  const removed = await dbWrite.$queryRaw<Removed[]>`
    WITH d AS (
      DELETE FROM "ImageResourceNew" irn
      WHERE irn."modelVersionId" = ANY(${ids}::int[])
        AND NOT EXISTS (SELECT 1 FROM "ModelVersion" mv WHERE mv.id = irn."modelVersionId")
      RETURNING irn.*
    )
    INSERT INTO ${CAPTURE} ("imageId", "modelVersionId", "strength", "detected", "tier")
    SELECT "imageId", "modelVersionId", "strength", "detected", 'dangling' FROM d
    RETURNING "imageId", "modelVersionId"
  `;
  return { count: removed.length, removed };
}

// Same rule as filterViewableModelVersions, restricted to rows a client supplied: manual rows, and
// detected rows whose version is listed in meta.civitaiResources. Post-derived and hash-detected
// rows are left alone.
function nonVisiblePairs(db: typeof dbRead, lo: number, hi: number) {
  return db.$queryRaw<Pair[]>`
    WITH inv AS (
      SELECT mv.id, m."userId" AS owner,
        CASE WHEN mv.availability = 'Private' OR m.availability = 'Private'
             THEN 'private' ELSE 'never_published' END AS tier
      FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId"
      WHERE mv.id >= ${lo} AND mv.id < ${hi}
        AND (
          (mv."publishedAt" IS NULL AND (mv.status <> 'Published' OR m.status <> 'Published'))
          OR (mv.status = 'Published' AND m.status = 'Published'
              AND (mv.availability = 'Private' OR m.availability = 'Private'))
        )
    )
    SELECT irn."imageId", irn."modelVersionId", inv.tier
    FROM inv
    JOIN "ImageResourceNew" irn ON irn."modelVersionId" = inv.id
    JOIN "Image" i ON i.id = irn."imageId"
    LEFT JOIN "User" u ON u.id = i."userId"
    LEFT JOIN "Post" p ON p.id = i."postId"
    WHERE i."userId" <> inv.owner
      AND NOT coalesce(u."isModerator", false)
      AND (
        (NOT irn.detected AND p."modelVersionId" IS DISTINCT FROM irn."modelVersionId")
        OR (irn.detected
            AND jsonb_typeof(i.meta->'civitaiResources') = 'array'
            AND i.meta->'civitaiResources' @> jsonb_build_array(
              jsonb_build_object('modelVersionId', irn."modelVersionId")))
      )
      AND NOT (inv.tier = 'private' AND EXISTS (
        SELECT 1 FROM "EntityAccess" ea
        WHERE ea."accessToId" = inv.id AND ea."accessToType" = 'ModelVersion'
          AND ea."accessorType" = 'User' AND ea."accessorId" = i."userId"))
  `;
}

async function deletePairs(pairs: Pair[]) {
  if (!pairs.length) return [] as Removed[];
  return dbWrite.$queryRaw<Removed[]>`
    WITH p AS (
      SELECT * FROM unnest(
        ${pairs.map((x) => x.imageId)}::int[],
        ${pairs.map((x) => x.modelVersionId)}::int[],
        ${pairs.map((x) => x.tier)}::text[]
      ) AS p("imageId", "modelVersionId", tier)
    ), d AS (
      DELETE FROM "ImageResourceNew" irn USING p
      WHERE irn."imageId" = p."imageId" AND irn."modelVersionId" = p."modelVersionId"
      RETURNING irn.*, p.tier
    )
    INSERT INTO ${CAPTURE} ("imageId", "modelVersionId", "strength", "detected", "tier")
    SELECT "imageId", "modelVersionId", "strength", "detected", tier FROM d
    RETURNING "imageId", "modelVersionId"
  `;
}

async function afterRemoval(removed: Removed[]) {
  if (!removed.length) return;
  const imageIds = uniq(removed.map((r) => r.imageId));
  await queueImageSearchIndexUpdate({ ids: imageIds, action: SearchIndexUpdateQueueAction.Update });
  await imageResourcesCache.bust(imageIds);
  await bustCacheTag(uniq(removed.map((r) => `images-modelVersion:${r.modelVersionId}`)));
}

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);
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

  const startedAt = Date.now();
  let cursor = params.start;
  let rows = 0;
  let largestBatch = 0;
  const byTier: Record<string, number> = {};
  const imageIds = new Set<number>();

  while (cursor < end && Date.now() - startedAt < params.budgetMs) {
    const hi = Math.min(cursor + chunk, end);

    if (params.tier === 'dangling') {
      const ids = await missingVersionIds(cursor, hi);
      for (let i = 0; i < ids.length; i += ID_BATCH) {
        const { count, removed } = await sweepDanglingIds(
          ids.slice(i, i + ID_BATCH),
          params.dryRun
        );
        rows += count;
        largestBatch = Math.max(largestBatch, count);
        byTier.dangling = (byTier.dangling ?? 0) + count;
        removed.forEach((r) => imageIds.add(r.imageId));
        await afterRemoval(removed);
      }
    } else {
      const pairs = await nonVisiblePairs(params.dryRun ? dbRead : dbWrite, cursor, hi);
      const removed = params.dryRun ? pairs : await deletePairs(pairs);
      const tierOf = new Map(pairs.map((p) => [`${p.imageId}:${p.modelVersionId}`, p.tier]));
      for (const r of removed) {
        const tier = tierOf.get(`${r.imageId}:${r.modelVersionId}`) ?? 'unknown';
        byTier[tier] = (byTier[tier] ?? 0) + 1;
        imageIds.add(r.imageId);
      }
      rows += removed.length;
      largestBatch = Math.max(largestBatch, removed.length);
      if (!params.dryRun) await afterRemoval(removed);
    }

    cursor = hi;
    if (params.tier === 'dangling' && cursor < end) {
      // Credited version ids above the ModelVersion range are sparse; skip the empty stretches.
      const [{ next }] = await dbRead.$queryRaw<{ next: number | null }[]>`
        SELECT min("modelVersionId") AS next FROM "ImageResourceNew" WHERE "modelVersionId" >= ${cursor}
      `;
      cursor = next ?? end;
    }
    if (cursor < end && params.sleepMs) await sleep(params.sleepMs);
  }

  return res.status(200).json({
    tier: params.tier,
    dryRun: params.dryRun,
    rows,
    byTier,
    images: imageIds.size,
    largestBatch,
    nextStart: cursor >= end ? null : cursor,
  });
});
