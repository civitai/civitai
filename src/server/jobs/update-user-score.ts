import type { PrismaClient } from '@prisma/client';
import { chunk } from 'lodash-es';
import type { CustomClickHouseClient } from '~/server/clickhouse/client';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { templateHandler } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import type { JobContext } from './job';
import { createJob, getJobDate } from './job';
import { userUpdateCounter } from '~/server/prom/client';

const BATCH_SIZE = 500;
const log = createLogger('update-user-score');
const jobKey = 'update-user-score';
export const updateUserScore = createJob(
  jobKey,
  '55 23 * * *',
  async (jobContext) => {
    if (!clickhouse) return;

    // Build Context
    //-------------------------------------
    // Legacy combined checkpoint. Seeds each per-category checkpoint on first run
    // after this change so the cutover doesn't rescan from epoch; ignored once the
    // per-category keys exist and own their own progress.
    const [legacyLastUpdate] = await getJobDate(jobKey);
    const ctx: Context = {
      db: dbWrite,
      ch: clickhouse,
      pg: pgDbWrite,
      jobContext,
      scoreMultipliers: await getScoreMultipliers(),
      lastUpdate: legacyLastUpdate,
      toUpdate: {},
      setScore: (id, category, score) => {
        if (!ctx.toUpdate[id]) ctx.toUpdate[id] = {};
        ctx.toUpdate[id][category] = Number(score);
      },
    };

    // Update scores
    //-------------------------------------
    // Each category advances its own checkpoint. A fetcher that throws is isolated:
    // its checkpoint stays frozen (retried next run) while the others still persist
    // and advance — one broken category can't freeze all six (as images did nightly
    // from 2026-06-22). Failures are collected and re-thrown after the good work is
    // committed, so the run still surfaces as failed for alerting.
    const scoreFetchers = {
      models: getModelScore,
      articles: getArticleScore,
      users: getUserScore,
      reportsActioned: getReportedActionedScore,
      reportsAgainst: getReportAgainstScore,
      images: getImageScore,
    } as const;

    const advanceCheckpoint: Array<() => Promise<void>> = [];
    const failures: Array<{ category: string; error: unknown }> = [];
    for (const [category, fetcher] of Object.entries(scoreFetchers)) {
      const [lastUpdate, setLastUpdate] = await getJobDate(
        `${jobKey}:${category}`,
        legacyLastUpdate
      );
      ctx.lastUpdate = lastUpdate;
      try {
        log('getting score', category);
        await fetcher(ctx);
        advanceCheckpoint.push(setLastUpdate);
      } catch (e) {
        log('score category failed; leaving its checkpoint frozen', category, e);
        failures.push({ category, error: e });
      }
    }

    // Update score totals
    //-------------------------------------
    const totalTasks = await getUpdateTotalTasks(ctx);
    log('updating scores', Object.keys(ctx.toUpdate).length, 'batches', totalTasks.length);
    await limitConcurrency(totalTasks, 5);

    // Advance only the categories that fetched cleanly, and only after their scores
    // are persisted.
    for (const setLastUpdate of advanceCheckpoint) await setLastUpdate();

    // Re-throw so the run still surfaces as failed. Each category's original stack
    // is embedded into the thrown error's own stack: the job runner logs
    // `error.stack` to Axiom (job.ts) and ignores `.cause`/AggregateError.errors,
    // so embedding is the only way the real failure site survives.
    if (failures.length) {
      const summary = `update-user-score: ${failures.length} categor${
        failures.length > 1 ? 'ies' : 'y'
      } failed (${failures.map((f) => f.category).join(', ')})`;
      const err = new Error(summary);
      err.stack = [
        summary,
        ...failures.map(({ category, error }) => {
          const detail = error instanceof Error ? error.stack ?? error.message : String(error);
          return `\n--- ${category} ---\n${detail}`;
        }),
      ].join('');
      throw err;
    }
  },
  {
    lockExpiration: 30 * 60,
    queue: 'metrics',
  }
);

type Context = {
  db: PrismaClient;
  ch: CustomClickHouseClient;
  pg: AugmentedPool;
  jobContext: JobContext;
  scoreMultipliers: ScoreMultipliers;
  toUpdate: Record<number, Partial<Record<ScoreCategory, number>>>;
  setScore: (id: number, category: ScoreCategory, score: number) => void;
  lastUpdate: Date;
};

async function getModelScore(ctx: Context) {
  await getScores(ctx, 'models')`
    SELECT
      mm."userId",
      (
          SUM(mm."thumbsUpCount") * ${ctx.scoreMultipliers.models.reviews}
        + SUM(mm."downloadCount") * ${ctx.scoreMultipliers.models.downloads}
        + SUM(mm."generationCount") * ${ctx.scoreMultipliers.models.generations}
      ) as score
    FROM "ModelMetric" mm
    GROUP BY 1
    HAVING BOOL_OR(mm."updatedAt" > '${ctx.lastUpdate}')
  `;
}

async function getArticleScore(ctx: Context) {
  await getScores(ctx, 'articles')`
    SELECT
      "userId",
      (
          SUM(am."viewCount") * ${ctx.scoreMultipliers.articles.views}
        + SUM(am."commentCount") * ${ctx.scoreMultipliers.articles.comments}
        + SUM(am."likeCount"+am."heartCount"+am."laughCount"+am."cryCount") * ${ctx.scoreMultipliers.articles.reactions}
      ) as score
    FROM "ArticleMetric" am
    JOIN "Article" a ON a.id = am."articleId"
    WHERE am.timeframe = 'AllTime'
    GROUP BY 1
    HAVING BOOL_OR(am."updatedAt" > '${ctx.lastUpdate}')
  `;
}

// Incremental image score: fold each affected owner's engagement DELTA since the
// last run onto their stored `images` score. Work scales with the images that
// changed (~hundreds of thousands/day), NOT with each owner's full catalog (the
// old full-recompute read tens of millions of `Image` rows nightly and timed the
// job out). NOT idempotent — the images checkpoint must advance each run, and a
// full recompute (`admin/temp/backfill-image-scores?force=true`) reconciles drift.
export async function getImageScore(ctx: Context) {
  // 1. Net engagement delta per image since the checkpoint. `metricValue` is
  // signed (un-likes / removed comments are negative), so this is the exact change
  // in each image's reaction/comment totals — no catalog read needed.
  const deltas = await ctx.ch.$query<ImageEngagementDelta>`
    SELECT entityId AS imageId,
      sumIf(metricValue, metricType IN ('Like', 'Heart', 'Laugh', 'Cry')) AS dReactions,
      sumIf(metricValue, metricType = 'commentCount') AS dComments
    FROM entityMetricEvents_month
    WHERE entityType = 'Image'
    AND metricType IN ('Like', 'Heart', 'Laugh', 'Cry', 'commentCount')
    AND createdAt > ${ctx.lastUpdate}
    GROUP BY entityId
    HAVING dReactions != 0 OR dComments != 0
  `;
  if (!deltas.length) return;

  // 2. Changed image -> owner (Postgres is authoritative; deleted images and null
  // owners drop out here and are skipped by the rollup).
  const ownerByImage = new Map<number, number>();
  for (const batch of chunk(deltas, 10000)) {
    const ids = batch.map((d) => d.imageId);
    const query = await ctx.pg.cancellableQuery<{ id: number; userId: number }>(
      `SELECT id, "userId" FROM "Image" WHERE id = ANY($1::int[]) AND "userId" IS NOT NULL`,
      [ids]
    );
    ctx.jobContext.on('cancel', query.cancel);
    for (const { id, userId } of await query.result()) ownerByImage.set(id, userId);
  }

  // 3. Roll deltas up per owner.
  const scoreDeltaByUser = rollupImageScoreDeltas(deltas, ownerByImage, ctx.scoreMultipliers.images);
  if (!scoreDeltaByUser.size) return;

  // 4. Fold each delta onto the owner's stored images score -> new absolute value,
  // handed to the shared persist path (which recomputes `total`).
  const userIds = [...scoreDeltaByUser.keys()];
  for (const ids of chunk(userIds, 5000)) {
    const query = await ctx.pg.cancellableQuery<{ id: number; images: string | null }>(
      `SELECT id, (meta->'scores'->>'images') AS images FROM "User" WHERE id = ANY($1::int[])`,
      [ids]
    );
    ctx.jobContext.on('cancel', query.cancel);
    const stored = new Map<number, number>();
    for (const { id, images } of await query.result()) stored.set(id, images ? Number(images) : 0);

    const partialDelta = new Map(ids.map((id) => [id, scoreDeltaByUser.get(id) ?? 0]));
    for (const [userId, score] of foldImageDeltasOntoStored(partialDelta, stored)) {
      ctx.setScore(userId, 'images', score);
    }
  }
}

export type ImageEngagementDelta = { imageId: number; dReactions: number; dComments: number };

// Roll per-image engagement deltas up per owner. Images missing from
// `ownerByImage` (deleted, or null userId) are dropped — their owner can't be
// credited, which also keeps deleted-image engagement out of the delta window.
export function rollupImageScoreDeltas(
  deltas: ImageEngagementDelta[],
  ownerByImage: Map<number, number>,
  multipliers: { reactions: number; comments: number }
): Map<number, number> {
  const byUser = new Map<number, number>();
  for (const { imageId, dReactions, dComments } of deltas) {
    const userId = ownerByImage.get(imageId);
    if (!userId) continue;
    const delta =
      Number(dReactions) * multipliers.reactions + Number(dComments) * multipliers.comments;
    byUser.set(userId, (byUser.get(userId) ?? 0) + delta);
  }
  return byUser;
}

// New absolute images score = stored (or 0) + this run's delta. Keeps `images`
// in the shared absolute-score persist path so `total` is recomputed there.
export function foldImageDeltasOntoStored(
  scoreDeltaByUser: Map<number, number>,
  storedByUser: Map<number, number>
): Map<number, number> {
  const result = new Map<number, number>();
  for (const [userId, delta] of scoreDeltaByUser) {
    result.set(userId, (storedByUser.get(userId) ?? 0) + delta);
  }
  return result;
}

async function getUserScore(ctx: Context) {
  await getScores(ctx, 'users')`
    SELECT
      "userId",
      "followerCount" * ${ctx.scoreMultipliers.users.followers} as score
    FROM "UserMetric"
    WHERE "updatedAt" > '${ctx.lastUpdate}'
    AND timeframe = 'AllTime'
  `;
}

async function getReportedActionedScore(ctx: Context) {
  await getScores(ctx, 'reportsActioned')`
    SELECT
      "userId",
      COUNT(id) * ${ctx.scoreMultipliers.reportsActioned} as score
    FROM "Report"
    WHERE status = 'Actioned'
    GROUP BY 1
    HAVING BOOL_OR("statusSetAt" > '${ctx.lastUpdate}')
  `;
}

async function getReportAgainstScore(ctx: Context) {
  const affected = await ctx.ch.$query<{ id: number; violations: number }>`
    WITH affected AS (
      SELECT DISTINCT
        ownerId
      FROM images
      WHERE type = 'DeleteTOS'
      AND time > ${ctx.lastUpdate}
    )
    SELECT
      ownerId as id,
      uniq(imageId) as violations
    FROM images
    WHERE type = 'DeleteTOS'
    AND ownerId IN (SELECT ownerId FROM affected)
    GROUP BY 1;
  `;

  for (const { id, violations } of affected) {
    const score = violations * ctx.scoreMultipliers.reportsAgainst;
    ctx.setScore(id, 'reportsAgainst', score);
  }
}

async function getUpdateTotalTasks(ctx: Context) {
  const tasks = chunk(Object.entries(ctx.toUpdate), BATCH_SIZE).map((records) => async () => {
    ctx.jobContext.checkIfCanceled();
    await applyUserScoreUpdates(ctx.pg, records, (cancel) => ctx.jobContext.on('cancel', cancel));
    userUpdateCounter?.inc({ location: 'job:update-user-score' }, records.length);
  });

  return tasks;
}

// Persist per-category scores and recompute `total` for a batch of users in one
// statement. `records` are `[userId, { category: score }]` entries; each total is
// the sum of the six categories, taking the freshly-supplied value when present
// and otherwise the user's previously-stored value. Shared by the cron job and
// the `testing/user-score` debug endpoint.
export async function applyUserScoreUpdates(
  pg: AugmentedPool,
  records: [string, Partial<Record<ScoreCategory, number>>][],
  onCancel?: (cancel: () => Promise<void>) => void
) {
  if (!records.length) return;

  const dataJson = JSON.stringify(records.map(([id, scores]) => ({ id: +id, scores })));
  const updateQuery = await pg.cancellableQuery(`
    WITH scores AS (SELECT * FROM jsonb_to_recordset('${dataJson}') AS x("id" int, "scores" jsonb))
    UPDATE "User" u
      SET meta = jsonb_set(COALESCE(meta, '{}'), '{scores}', COALESCE(meta->'scores', '{}') || s.scores || jsonb_build_object('total',
          COALESCE((s.scores->>'models')::numeric, (u.meta->'scores'->>'models')::numeric, 0)
          + COALESCE((s.scores->>'articles')::numeric, (u.meta->'scores'->>'articles')::numeric, 0)
          + COALESCE((s.scores->>'images')::numeric, (u.meta->'scores'->>'images')::numeric, 0)
          + COALESCE((s.scores->>'users')::numeric, (u.meta->'scores'->>'users')::numeric, 0)
          + COALESCE((s.scores->>'reportsActioned')::numeric, (u.meta->'scores'->>'reportsActioned')::numeric, 0)
          + COALESCE((s.scores->>'reportsAgainst')::numeric, (u.meta->'scores'->>'reportsAgainst')::numeric, 0)
        )
      )
    FROM scores s
    WHERE s.id = u.id;
  `);
  onCancel?.(updateQuery.cancel);
  await updateQuery.result();
}

// #region [helpers]
type ScoreMultipliers = {
  models: {
    reviews: number;
    downloads: number;
    generations: number;
  };
  articles: {
    views: number;
    comments: number;
    reactions: number;
  };
  images: {
    views: number;
    comments: number;
    reactions: number;
  };
  users: {
    followers: number;
  };
  reportsActioned: number;
  reportsAgainst: number;
};
type ScoreCategory = keyof ScoreMultipliers | 'total';

// The multipliers live in the `system:user-score-multipliers` key, stored both
// in sysRedis (legacy/hot-override) and PG `KeyValue` (durable). Same key string
// for both stores.
const USER_SCORE_MULTIPLIERS_KEY = REDIS_SYS_KEYS.SYSTEM.USER_SCORE_MULTIPLIERS;

// Hardcoded last-resort default. Recovered 2026-06-22 after the sysRedis instance
// was wiped ~2026-05-14, which dropped the only copy of these values and silently
// killed this job for ~39 nights (it threw on the missing key before any category
// ran). Reverse-engineered from frozen `User.meta.scores`: 5/6 categories exact;
// articles.comments/reactions are a best-estimate (~5% noise). Prefer the values
// in redis/KeyValue over these once re-seeded.
const DEFAULT_SCORE_MULTIPLIERS: ScoreMultipliers = {
  models: { reviews: 10, downloads: 1, generations: 1 },
  articles: { views: 1, comments: 25, reactions: 10 },
  images: { views: 0, comments: 20, reactions: 10 },
  users: { followers: 50 },
  reportsActioned: 50,
  reportsAgainst: -1000,
};

// Defense in depth so a single wiped/offline store can never freeze all user
// scores again: sysRedis (hot override) -> PG KeyValue (durable) -> hardcoded
// default. Each read is guarded so an ERROR (e.g. redis client offline), not just
// a miss, falls through to the next source.
export async function getScoreMultipliers(): Promise<ScoreMultipliers> {
  try {
    const fromRedis = await sysRedis.packed.get<ScoreMultipliers>(USER_SCORE_MULTIPLIERS_KEY);
    if (fromRedis) return fromRedis;
  } catch (e) {
    log('score multipliers: sysRedis read failed, falling back to KeyValue', (e as Error).message);
  }

  try {
    const fromDb = await dbRead.keyValue.findUnique({ where: { key: USER_SCORE_MULTIPLIERS_KEY } });
    if (fromDb?.value) return fromDb.value as unknown as ScoreMultipliers;
  } catch (e) {
    log('score multipliers: KeyValue read failed, using default', (e as Error).message);
  }

  log('score multipliers: sysRedis + KeyValue unavailable, using hardcoded default');
  return DEFAULT_SCORE_MULTIPLIERS;
}

function getScores(ctx: Context, category: ScoreCategory) {
  return templateHandler(async (sql) => {
    const query = await ctx.pg.cancellableQuery<{ userId: number; score: number }>(sql);
    ctx.jobContext.on('cancel', query.cancel);
    const scores = await query.result();
    for (const { userId, score } of scores) ctx.setScore(userId, category, score);
  });
}
// #endregion
