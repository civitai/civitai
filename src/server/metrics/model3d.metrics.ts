import { chunk } from 'lodash-es';
import { templateHandler } from '~/server/db/db-helpers';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { executeRefresh, getAffected } from '~/server/metrics/metric-helpers';
import type { Task } from '~/server/utils/concurrency-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:model3d');
const BATCH_SIZE = 200;

// AllTime-only: Model3DMetric is a single row keyed by model3dId (no
// `timeframe` column, unlike ModelMetric / PostMetric). Every value we
// compute here is rolled up across all time.
const metricKeys = [
  'commentCount',
  'collectedCount',
  'imageCount',
  'tippedCount',
  'tippedAmountCount',
  'ratingCount',
  'recommendedCount',
  'reactionCount',
  'earnedAmount',
  // NOTE: `downloadCount` is intentionally absent. The plan (§6.16 / §3
  // touch list) sources downloads from ClickHouse events; that's a follow-up
  // outside workstream E. The column defaults to 0 in the schema and the
  // upsert below preserves whatever's there, so adding the ClickHouse path
  // later is purely additive.
] as const;

type MetricKey = (typeof metricKeys)[number];

type MetricContext = MetricProcessorRunContext & {
  updates: Record<number, Record<string, number>>;
  idKey: string;
};

export const model3dMetrics = createMetricProcessor({
  name: 'Model3D',
  async update(baseCtx) {
    const ctx = baseCtx as MetricContext;
    ctx.updates = {};
    ctx.idKey = 'model3dId';

    // Get the metric tasks
    //---------------------------------------
    const fetchTasks = (await Promise.all([
      getCommentTasks(ctx),
      getReviewTasks(ctx),
      getCollectionTasks(ctx),
      getBuzzTasks(ctx),
      getReactionTasks(ctx),
      getImageTasks(ctx),
      getEarnedTasks(ctx),
    ]).then((x) => x.flat())) as Task[];
    log('model3dMetrics update', fetchTasks.length, 'tasks');
    await limitConcurrency(fetchTasks, 5);

    // Bulk insert metrics
    //---------------------------------------
    const metricInsertColumns = metricKeys.map((key) => `"${key}" INT`).join(', ');
    const metricInsertKeys = metricKeys.map((key) => `"${key}"`).join(', ');
    const metricValues = metricKeys
      .map((key) => `COALESCE(d."${key}", mm."${key}", 0) as "${key}"`)
      .join(',\n');
    const metricOverrides = metricKeys
      .map((key) => `"${key}" = EXCLUDED."${key}"`)
      .join(',\n');

    const updateTasks = chunk(Object.values(ctx.updates), 100).map((batch, i) => async () => {
      ctx.jobContext.checkIfCanceled();
      log('update metrics', i + 1, 'of', updateTasks.length);
      await executeRefresh(ctx)`
        -- update Model3D metrics
        WITH data AS (
          SELECT * FROM jsonb_to_recordset(${batch}::jsonb)
          AS x("model3dId" INT, ${metricInsertColumns})
        )
        INSERT INTO "Model3DMetric" (
          "model3dId",
          "updatedAt",
          ${metricInsertKeys},
          "nsfwLevel",
          "userId",
          "status",
          "availability",
          "poi",
          "minor"
        )
        SELECT
          d."model3dId",
          NOW() as "updatedAt",
          ${metricValues},
          -- Denormalize the Model3D row into the metric row so feed sorts /
          -- filters never have to JOIN. Keep these in sync with whatever the
          -- Model3D mutations write back; the rest of the surface area treats
          -- Model3DMetric as the cheap-read source of truth.
          COALESCE(m3d."nsfwLevel", 0) as "nsfwLevel",
          COALESCE(m3d."userId", 0) as "userId",
          COALESCE(m3d."status", 'Draft'::"Model3DStatus") as "status",
          COALESCE(m3d."availability", 'Public'::"Availability") as "availability",
          COALESCE(m3d."poi", FALSE) as "poi",
          COALESCE(m3d."minor", FALSE) as "minor"
        FROM data d
        LEFT JOIN "Model3DMetric" mm ON mm."model3dId" = d."model3dId"
        LEFT JOIN "Model3D" m3d ON m3d.id = d."model3dId"
        WHERE EXISTS (SELECT 1 FROM "Model3D" WHERE id = d."model3dId")
        ON CONFLICT ("model3dId") DO UPDATE
          SET
            ${metricOverrides},
            "nsfwLevel" = EXCLUDED."nsfwLevel",
            "userId" = EXCLUDED."userId",
            "status" = EXCLUDED."status",
            "availability" = EXCLUDED."availability",
            "poi" = EXCLUDED."poi",
            "minor" = EXCLUDED."minor",
            "updatedAt" = NOW()
      `;
      log('update metrics', i + 1, 'of', updateTasks.length, 'done');
    });
    await limitConcurrency(updateTasks, 10);

    // TODO(phase2): once the dedicated `model3d` Meilisearch index lands
    // (plan §2.9), queue affected ids here just like articleMetrics does.
  },
  // No rank table for Model3D in v1 (no popularity sort yet). Phase 2 may
  // add a Model3DRank materialized view; for now feed sort uses the metric
  // table directly.
});

// ---------------------------------------------------------------------------
// Comments (CommentV2 attached to a Thread with model3dId)
// ---------------------------------------------------------------------------
async function getCommentTasks(ctx: MetricContext) {
  const affected = await getAffected(ctx)`
    -- get recent Model3D comments
    SELECT t."model3dId" as id
    FROM "Thread" t
    JOIN "CommentV2" c ON c."threadId" = t.id
    WHERE t."model3dId" IS NOT NULL AND c."createdAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getCommentTasks', i + 1, 'of', tasks.length);
    await getMetrics(ctx)`
      -- get Model3D comment metrics
      SELECT
        t."model3dId",
        COUNT(c.id)::int AS "commentCount"
      FROM "Thread" t
      JOIN "CommentV2" c ON c."threadId" = t.id
      WHERE t."model3dId" IN (${ids})
        AND t."model3dId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY t."model3dId"
    `;
    log('getCommentTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

// ---------------------------------------------------------------------------
// Reviews (Model3DReview) → ratingCount, recommendedCount
// ---------------------------------------------------------------------------
async function getReviewTasks(ctx: MetricContext) {
  const affected = await getAffected(ctx)`
    -- get recent Model3D reviews
    SELECT DISTINCT "model3dId" as id
    FROM "Model3DReview"
    WHERE "createdAt" > ${ctx.lastUpdate} OR "updatedAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getReviewTasks', i + 1, 'of', tasks.length);
    await getMetrics(ctx)`
      -- get Model3D review rollup
      -- The UI is fully thumbs-based (recommend / don't recommend), so the
      -- rollup is derived from \`recommended\` directly:
      --   ratingCount      = distinct reviewers
      --   recommendedCount = distinct reviewers who recommended
      -- Clients compute the recommend % as recommendedCount / ratingCount.
      -- Excludes tos-violating / author-excluded reviews so a bad review
      -- doesn't poison the rollup.
      SELECT
        r."model3dId",
        COUNT(DISTINCT r."userId")::int AS "ratingCount",
        COUNT(DISTINCT r."userId") FILTER (WHERE r.recommended)::int AS "recommendedCount"
      FROM "Model3DReview" r
      WHERE r.exclude = FALSE
        AND r."tosViolation" = FALSE
        AND r."model3dId" IN (${ids})
        AND r."model3dId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY r."model3dId"
    `;
    log('getReviewTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

// ---------------------------------------------------------------------------
// Collections (CollectionItem.model3dId)
// ---------------------------------------------------------------------------
async function getCollectionTasks(ctx: MetricContext) {
  const affected = await getAffected(ctx)`
    -- get recent Model3D collection items
    SELECT DISTINCT "model3dId" as id
    FROM "CollectionItem"
    WHERE "model3dId" IS NOT NULL AND "createdAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getCollectionTasks', i + 1, 'of', tasks.length);
    await getMetrics(ctx)`
      -- get Model3D collected metrics
      SELECT
        ci."model3dId",
        COUNT(*)::int AS "collectedCount"
      FROM "CollectionItem" ci
      WHERE ci."model3dId" IN (${ids})
        AND ci."model3dId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY ci."model3dId"
    `;
    log('getCollectionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

// ---------------------------------------------------------------------------
// Buzz tips against the Model3D entity → tippedCount / tippedAmountCount
// (per-entity rollup; the creator-earnings number is computed separately
// in getEarnedTasks because that one rolls across the creator's whole
// Model3D catalogue.)
// ---------------------------------------------------------------------------
async function getBuzzTasks(ctx: MetricContext) {
  const affected = await getAffected(ctx)`
    -- get recent Model3D tips
    SELECT "entityId" as id
    FROM "BuzzTip"
    WHERE "entityType" = 'Model3D'
      AND ("createdAt" > ${ctx.lastUpdate} OR "updatedAt" > ${ctx.lastUpdate})
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getBuzzTasks', i + 1, 'of', tasks.length);
    await getMetrics(ctx)`
      -- get Model3D tip metrics
      SELECT
        bt."entityId" AS "model3dId",
        COUNT(*)::int AS "tippedCount",
        SUM(bt.amount)::int AS "tippedAmountCount"
      FROM "BuzzTip" bt
      WHERE bt."entityId" IN (${ids})
        AND bt."entityId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
        AND bt."entityType" = 'Model3D'
      GROUP BY bt."entityId"
    `;
    log('getBuzzTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

// ---------------------------------------------------------------------------
// Reactions — denormalized from the thumbnail Image's ImageMetric
// (see plan §2.10 / §6.15: reactions ride on the thumbnail Image, no
// dedicated Model3DReaction table. We copy the rolled-up reactionCount
// from the AllTime ImageMetric so feed sorts can read it locally.)
// ---------------------------------------------------------------------------
async function getReactionTasks(ctx: MetricContext) {
  const affected = await getAffected(ctx)`
    -- Model3Ds whose thumbnail Image's metrics changed recently.
    SELECT m3d.id
    FROM "Model3D" m3d
    JOIN "ImageMetric" im
      ON im."imageId" = m3d."thumbnailImageId"
      AND im.timeframe = 'AllTime'::"MetricTimeframe"
    WHERE m3d."thumbnailImageId" IS NOT NULL
      AND im."updatedAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getReactionTasks', i + 1, 'of', tasks.length);
    await getMetrics(ctx)`
      -- pull AllTime reactionCount from the thumbnail's ImageMetric
      SELECT
        m3d.id AS "model3dId",
        COALESCE(im."reactionCount", 0)::int AS "reactionCount"
      FROM "Model3D" m3d
      LEFT JOIN "ImageMetric" im
        ON im."imageId" = m3d."thumbnailImageId"
        AND im.timeframe = 'AllTime'::"MetricTimeframe"
      WHERE m3d.id IN (${ids})
        AND m3d.id BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
    `;
    log('getReactionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

// ---------------------------------------------------------------------------
// Image count — total Images across all Posts that link to this Model3D.
// Includes both the creator's auto-Post (containing the generation thumb)
// and any community "Makes/Uses" Posts (plan §2.6).
// ---------------------------------------------------------------------------
async function getImageTasks(ctx: MetricContext) {
  const affected = await getAffected(ctx)`
    -- Model3Ds with new Posts or new Images in linked Posts since lastUpdate
    SELECT DISTINCT p."model3dId" as id
    FROM "Post" p
    WHERE p."model3dId" IS NOT NULL
      AND (
        p."publishedAt" > ${ctx.lastUpdate}
        OR EXISTS (
          SELECT 1 FROM "Image" i
          WHERE i."postId" = p.id
            AND (i."createdAt" > ${ctx.lastUpdate} OR i."updatedAt" > ${ctx.lastUpdate})
        )
      )
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getImageTasks', i + 1, 'of', tasks.length);
    await getMetrics(ctx)`
      -- get Model3D image-count metrics (Images across linked Posts)
      SELECT
        p."model3dId",
        COUNT(i.id)::int AS "imageCount"
      FROM "Post" p
      JOIN "Image" i ON i."postId" = p.id
      WHERE p."model3dId" IN (${ids})
        AND p."model3dId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
        AND p."publishedAt" IS NOT NULL
      GROUP BY p."model3dId"
    `;
    log('getImageTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

// ---------------------------------------------------------------------------
// Earned amount — sum of BuzzTip.amount paid out to the Model3D creator
// across all of their Model3Ds. Mirrors how ModelMetric.earnedAmount works
// (per-Model rollup of tips, not per-creator). Here we just rebroadcast
// the per-entity tip total since v1 doesn't have a separate "earnings"
// stream — every tip to a Model3D goes to the creator (no revenue split).
// Kept as a separate task so a later split (e.g. orchestrator credit) only
// needs to touch this function.
// ---------------------------------------------------------------------------
async function getEarnedTasks(ctx: MetricContext) {
  const affected = await getAffected(ctx)`
    -- Model3Ds whose tip total just changed
    SELECT "entityId" as id
    FROM "BuzzTip"
    WHERE "entityType" = 'Model3D'
      AND ("createdAt" > ${ctx.lastUpdate} OR "updatedAt" > ${ctx.lastUpdate})
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getEarnedTasks', i + 1, 'of', tasks.length);
    await getMetrics(ctx)`
      -- earned = total BuzzTip amount routed to the Model3D creator for
      -- this entity. Matches Model3D.userId against BuzzTip.toAccountType
      -- inheritance via the entity link -- since BuzzTip is polymorphic and
      -- we do not have a toUserId slot, we trust entityId+entityType.
      SELECT
        bt."entityId" AS "model3dId",
        SUM(bt.amount)::int AS "earnedAmount"
      FROM "BuzzTip" bt
      JOIN "Model3D" m3d ON m3d.id = bt."entityId"
      WHERE bt."entityType" = 'Model3D'
        AND bt."entityId" IN (${ids})
        AND bt."entityId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY bt."entityId"
    `;
    log('getEarnedTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

// ---------------------------------------------------------------------------
// Shared row → ctx.updates accumulator (mirrors articleMetrics.getMetrics)
// ---------------------------------------------------------------------------
function getMetrics(ctx: MetricContext) {
  return templateHandler(async (sql) => {
    const query = await ctx.pg.cancellableQuery<
      { model3dId: number } & Record<string, string | number>
    >(sql);
    ctx.jobContext.on('cancel', query.cancel);
    const data = await query.result();
    if (!data.length) return;

    for (const row of data) {
      const entityId = row.model3dId;
      ctx.updates[entityId] ??= { [ctx.idKey]: entityId };
      for (const key of Object.keys(row) as MetricKey[]) {
        if (key === (ctx.idKey as MetricKey)) continue;
        const value = row[key];
        if (value == null) continue;
        ctx.updates[entityId][key] = typeof value === 'string' ? Number(value) : (value as number);
      }
    }
  });
}
