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
    const [lastUpdate, setLastUpdate] = await getJobDate(jobKey);
    const ctx: Context = {
      db: dbWrite,
      ch: clickhouse,
      pg: pgDbWrite,
      jobContext,
      scoreMultipliers: await getScoreMultipliers(),
      lastUpdate,
      toUpdate: {},
      setScore: (id, category, score) => {
        if (!ctx.toUpdate[id]) ctx.toUpdate[id] = {};
        ctx.toUpdate[id][category] = Number(score);
      },
    };

    // Update scores
    //-------------------------------------
    const scoreFetchers = {
      getModelScore,
      getArticleScore,
      getUserScore,
      getReportedActionedScore,
      getReportAgainstScore,
      getImageScore,
    };
    for (const [key, fetcher] of Object.entries(scoreFetchers)) {
      log('getting score', key);
      await fetcher(ctx);
    }

    // Update score totals
    //-------------------------------------
    const totalTasks = await getUpdateTotalTasks(ctx);
    log('updating scores', Object.keys(ctx.toUpdate).length, 'batches', totalTasks.length);
    await limitConcurrency(totalTasks, 5);

    await setLastUpdate();
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

async function getImageScore(ctx: Context) {
  // Image engagement now lives in the v2 entity-metric aggregate (the legacy
  // `image_metrics_user` table is stale post-cutover). `entityMetricDailyAgg_v2`
  // is keyed by imageId with no owner column, and the ClickHouse `images` event
  // table is an incomplete owner source (event-sourced; missing Create rows for
  // older images), so the imageId -> owner join must come from Postgres.

  // 1. Images whose score-relevant engagement changed since the last run. Only
  // reactions + comments feed the image score, so we ignore view/collection/tip
  // events here to avoid rescoring owners whose score can't have changed.
  const changed = await ctx.ch.$query<{ imageId: number }>`
    SELECT DISTINCT entityId AS imageId
    FROM entityMetricEvents_month
    WHERE entityType = 'Image'
    AND metricType IN ('Like', 'Heart', 'Laugh', 'Cry', 'commentCount')
    AND createdAt > ${ctx.lastUpdate}
  `;
  if (!changed.length) return;
  const changedImageIds = changed.map((x) => x.imageId);

  // 2. Changed images -> affected owners (Postgres is the authoritative owner map).
  const affectedUserIds = new Set<number>();
  for (const ids of chunk(changedImageIds, 10000)) {
    const query = await ctx.pg.cancellableQuery<{ userId: number }>(
      `SELECT DISTINCT "userId" FROM "Image" WHERE id = ANY($1::int[]) AND "userId" IS NOT NULL`,
      [ids]
    );
    ctx.jobContext.on('cancel', query.cancel);
    for (const { userId } of await query.result()) affectedUserIds.add(userId);
  }
  if (!affectedUserIds.size) return;

  // 3. Recompute each affected owner's FULL all-time image score (including
  // owners who now total 0, so a previously-stale score is corrected downward).
  const scores = await computeImageScores(
    {
      ch: ctx.ch,
      pg: ctx.pg,
      scoreMultipliers: ctx.scoreMultipliers,
      onCancel: (cancel) => ctx.jobContext.on('cancel', cancel),
    },
    [...affectedUserIds]
  );
  for (const [userId, { score }] of scores) ctx.setScore(userId, 'images', score);
}

type ImageScoreDeps = {
  ch: CustomClickHouseClient;
  pg: AugmentedPool;
  scoreMultipliers: ScoreMultipliers;
  onCancel?: (cancel: () => Promise<void>) => void;
};

export type ImageScoreBreakdown = { reactions: number; comments: number; score: number };

// Compute each user's all-time image score from the v2 entity-metric aggregate.
// `entityMetricDailyAgg_v2` is keyed by imageId with no owner, so the
// imageId -> owner mapping comes from Postgres `Image` (the ClickHouse `images`
// event table is an incomplete owner source). Every requested userId is present
// in the result (score 0 when there's no engagement). Shared by the cron job and
// the `admin/temp/backfill-image-scores` endpoint so both exercise the same logic.
export async function computeImageScores(
  deps: ImageScoreDeps,
  userIds: number[]
): Promise<Map<number, ImageScoreBreakdown>> {
  const result = new Map<number, ImageScoreBreakdown>();
  if (!userIds.length) return result;

  // imageId -> userId for every image these users own.
  const ownerByImage = new Map<number, number>();
  for (const ids of chunk(userIds, 1000)) {
    const query = await deps.pg.cancellableQuery<{ id: number; userId: number }>(
      `SELECT id, "userId" FROM "Image" WHERE "userId" = ANY($1::int[])`,
      [ids]
    );
    deps.onCancel?.(query.cancel);
    for (const { id, userId } of await query.result()) ownerByImage.set(id, userId);
  }

  // Sum per-image reactions/comments from the v2 aggregate, roll up per owner.
  const totals = new Map<number, { reactions: number; comments: number }>();
  for (const ids of chunk([...ownerByImage.keys()], 5000)) {
    const rows = await deps.ch.$query<{ imageId: number; reactions: number; comments: number }>(`
      SELECT entityId AS imageId,
        sumIf(total, metricType IN ('Like', 'Heart', 'Laugh', 'Cry')) AS reactions,
        sumIf(total, metricType = 'commentCount') AS comments
      FROM entityMetricDailyAgg_v2
      WHERE entityType = 'Image'
      AND entityId IN (${ids.join(',')})
      GROUP BY entityId
    `);
    for (const { imageId, reactions, comments } of rows) {
      const userId = ownerByImage.get(imageId);
      if (!userId) continue;
      const acc = totals.get(userId) ?? { reactions: 0, comments: 0 };
      acc.reactions += Number(reactions);
      acc.comments += Number(comments);
      totals.set(userId, acc);
    }
  }

  for (const userId of userIds) {
    const { reactions, comments } = totals.get(userId) ?? { reactions: 0, comments: 0 };
    const score =
      reactions * deps.scoreMultipliers.images.reactions +
      comments * deps.scoreMultipliers.images.comments;
    result.set(userId, { reactions, comments, score });
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

function getAffected(ctx: Context) {
  return templateHandler(async (sql) => {
    const affectedQuery = await ctx.pg.cancellableQuery<{ id: number }>(sql);
    ctx.jobContext.on('cancel', affectedQuery.cancel);
    const affected = await affectedQuery.result();
    const ids = affected.map((x) => x.id);
    return ids;
  });
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
