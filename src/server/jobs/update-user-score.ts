import { PrismaClient } from '@prisma/client';
import { chunk } from 'lodash-es';
import { clickhouse, CustomClickHouseClient } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { AugmentedPool, templateHandler } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import { createJob, getJobDate, JobContext } from './job';

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
      m."userId",
      (
          SUM(mm."ratingCount") * ${ctx.scoreMultipliers.models.reviews}
        + SUM(mm."downloadCount") * ${ctx.scoreMultipliers.models.downloads}
        + SUM(mm."generationCount") * ${ctx.scoreMultipliers.models.generations}
      ) as score
    FROM "ModelMetric" mm
    JOIN "Model" m ON m.id = mm."modelId"
    WHERE mm.timeframe = 'AllTime'
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
  const affected = await ctx.ch.$query<{ userId: number; score: number }>`
    WITH affected AS (
      SELECT DISTINCT i.userId as userId
      FROM images_created i
      JOIN entityMetricEvents em ON em.entityId = i.id
      WHERE em.entityType = 'Image'
        AND i.userId != -1
        AND em.createdAt > ${ctx.lastUpdate}
    )
    SELECT
      i.userId as userId,
      (
        SUM(
          if(em.metricType in ('ReactionLike', 'ReactionHeart', 'ReactionLaugh', 'ReactionCry'), em.metricValue, 0)
        ) * ${ctx.scoreMultipliers.images.reactions}
        + SUM(if(em.metricType = 'Comment', em.metricValue, 0)) * ${ctx.scoreMultipliers.images.comments}
      ) as score
    FROM entityMetricEvents em
    JOIN images_created i ON i.id = em.entityId
    WHERE em.entityType = 'Image'
      AND em.metricType NOT IN ('Collection', 'Buzz')
      AND i.id NOT IN (SELECT imageId FROM "images" ix WHERE ix.type IN ('Delete', 'DeleteTOS'))
      AND i.userId IN (SELECT * FROM affected)
    GROUP BY userId
  `;

  for (const { userId, score } of affected) {
    ctx.setScore(userId, 'images', score);
  }
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
  const tasks = chunk(Object.entries(ctx.toUpdate), BATCH_SIZE).map((records, i) => async () => {
    ctx.jobContext.checkIfCanceled();

    const dataJson = JSON.stringify(records.map(([id, scores]) => ({ id: +id, scores })));
    const updateQuery = await ctx.pg.cancellableQuery(`
      WITH scores AS (SELECT * FROM jsonb_to_recordset('${dataJson}') AS x("id" int, "scores" jsonb))
      UPDATE "User" u
        SET meta = jsonb_set(COALESCE(meta, '{}'), '{scores}', COALESCE(meta->'scores', '{}') || s.scores || jsonb_build_object('total',
            COALESCE((s.scores->>'models')::numeric, (u.meta->>'models')::numeric, 0)
            + COALESCE((s.scores->>'articles')::numeric, (u.meta->>'articles')::numeric, 0)
            + COALESCE((s.scores->>'images')::numeric, (u.meta->>'images')::numeric, 0)
            + COALESCE((s.scores->>'users')::numeric, (u.meta->>'users')::numeric, 0)
            + COALESCE((s.scores->>'reportsActioned')::numeric, (u.meta->>'reportsActioned')::numeric, 0)
            + COALESCE((s.scores->>'reportsAgainst')::numeric, (u.meta->>'reportsAgainst')::numeric, 0)
          )
        )
      FROM scores s
      WHERE s.id = u.id;
    `);
    ctx.jobContext.on('cancel', updateQuery.cancel);
    await updateQuery.result();
  });

  return tasks;
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

async function getScoreMultipliers() {
  const data = await sysRedis.packed.get<ScoreMultipliers>(
    REDIS_SYS_KEYS.SYSTEM.USER_SCORE_MULTIPLIERS
  );
  if (!data) throw new Error('User score multipliers not found in redis');
  return data;
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
