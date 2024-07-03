import { PrismaClient } from '@prisma/client';
import { chunk } from 'lodash-es';
import { clickhouse, CustomClickHouseClient } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { AugmentedPool, pgDbWrite, templateHandler } from '~/server/db/pgDb';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import { createJob, getJobDate, JobContext } from './job';

const BATCH_SIZE = 1000;
const log = createLogger('update-user-score');
const jobKey = 'update-user-score';
export const updateUserScore = createJob(
  jobKey,
  '55 23 * * *',
  async (jobContext) => {
    if (!clickhouse) return;

    // Build Context
    //-------------------------------------
    const [lastUpdate, setLastUpdate] = await getJobDate(jobKey, new Date('2024-07-03'));
    const ctx: Context = {
      db: dbWrite,
      ch: clickhouse,
      pg: pgDbWrite,
      jobContext,
      scoreMultipliers: await getScoreMultipliers(),
      lastUpdate,
      affected: new Set(),
      addAffected: (id) => {
        if (Array.isArray(id)) id.forEach((x) => ctx.affected.add(x));
        else ctx.affected.add(id);
      },
    };

    // Update scores
    //-------------------------------------
    const tasks: Task[] = [];
    const taskGenerators = {
      getModelTasks,
      getArticleTasks,
      getImageTasks,
      getUserTasks,
      getReportActionedTasks,
      getReportAgainstTasks,
    };
    for (const [key, generator] of Object.entries(taskGenerators)) {
      log('get tasks', key);
      tasks.push(...(await generator(ctx)));
    }
    log('score update', tasks.length, 'tasks');
    await limitConcurrency(tasks, 5);

    // Update score totals
    //-------------------------------------
    const totalTasks = await getUpdateTotalTasks(ctx);
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
  addAffected: (id: number | number[]) => void;
  affected: Set<number>;
  lastUpdate: Date;
};

async function getModelTasks(ctx: Context) {
  const affected = await getAffected(ctx)`
    SELECT DISTINCT
      m."userId" as id
    FROM "ModelMetric" mm
    JOIN "Model" m ON m.id = mm."modelId"
    WHERE mm."updatedAt" > '${ctx.lastUpdate}'
    AND timeframe = 'AllTime';
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getModelTasks', i + 1, 'of', tasks.length);

    await updateScores(ctx, 'models')`
      SELECT
        "userId",
        (
            SUM(mm."ratingCount") * ${ctx.scoreMultipliers.models.reviews}
          + SUM(mm."downloadCount") * ${ctx.scoreMultipliers.models.downloads}
          + SUM(mm."generationCount") * ${ctx.scoreMultipliers.models.generations}
        ) as score
      FROM "ModelMetric" mm
      JOIN "Model" m ON m.id = mm."modelId"
      WHERE mm.timeframe = 'AllTime'
      AND m."userId" IN (${ids})
      GROUP BY 1
    `;
  });

  return tasks;
}

async function getArticleTasks(ctx: Context) {
  const affected = await getAffected(ctx)`
    SELECT DISTINCT
      a."userId" as id
    FROM "ArticleMetric" am
    JOIN "Article" a ON a.id = am."articleId"
    WHERE am."updatedAt" > '${ctx.lastUpdate}'
    AND timeframe = 'AllTime';
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getArticleTasks', i + 1, 'of', tasks.length);

    await updateScores(ctx, 'articles')`
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
      AND a."userId" IN (${ids})
      GROUP BY 1
    `;
  });

  return tasks;
}

async function getImageTasks(ctx: Context) {
  const affected = await getAffected(ctx)`
    SELECT DISTINCT
      i."userId" as id
    FROM "ImageMetric" im
    JOIN "Image" i ON i.id = im."imageId"
    WHERE im."updatedAt" > '${ctx.lastUpdate}'
    AND timeframe = 'AllTime';
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getImageTasks', i + 1, 'of', tasks.length);

    await updateScores(ctx, 'images')`
      SELECT
        "userId",
        (
            SUM(im."viewCount") * ${ctx.scoreMultipliers.images.views}
          + SUM(im."commentCount") * ${ctx.scoreMultipliers.images.comments}
          + SUM(im."likeCount"+im."heartCount"+im."laughCount"+im."cryCount") * ${ctx.scoreMultipliers.images.reactions}
        ) as score
      FROM "ImageMetric" im
      JOIN "Image" i ON i.id = im."imageId"
      WHERE im.timeframe = 'AllTime'
      AND i."userId" IN (${ids})
      GROUP BY 1
    `;
  });

  return tasks;
}

async function getUserTasks(ctx: Context) {
  const affected = await getAffected(ctx)`
    SELECT DISTINCT
      "userId" as id
    FROM "UserMetric"
    WHERE "updatedAt" > '${ctx.lastUpdate}'
    AND timeframe = 'AllTime'
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getUserTasks', i + 1, 'of', tasks.length);

    await updateScores(ctx, 'users')`
      SELECT
        "userId",
        (
          "followerCount" * ${ctx.scoreMultipliers.users.followers}
        ) as score
      FROM "UserMetric"
      WHERE "userId" IN (${ids})
      AND timeframe = 'AllTime'
    `;
  });

  return tasks;
}

async function getReportActionedTasks(ctx: Context) {
  const affected = await getAffected(ctx)`
    SELECT DISTINCT
      "userId" as id
    FROM "Report" r
    WHERE "statusSetAt" > '${ctx.lastUpdate}'
      AND status = 'Actioned'
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getReportTasks', i + 1, 'of', tasks.length);

    await updateScores(ctx, 'reportsActioned')`
      SELECT
        "userId",
        (
          COUNT(id) * ${ctx.scoreMultipliers.reportsActioned}
        ) as score
      FROM "Report"
      WHERE "userId" IN (${ids}) AND status = 'Actioned'
      GROUP BY 1
    `;
  });

  return tasks;
}

async function getReportAgainstTasks(ctx: Context) {
  const affected = await ctx.ch.$query<{ id: number; violations: number }>`
    WITH affected AS (
      SELECT DISTINCT
        ownerId
      FROM images
      WHERE type = 'DeleteTOS'
      AND time > parseDateTimeBestEffortOrNull('${ctx.lastUpdate}')
    )
    SELECT
      ownerId as id,
      uniq(imageId) as violations
    FROM images
    WHERE type = 'DeleteTOS'
    AND ownerId IN (SELECT ownerId FROM affected)
    GROUP BY 1;
  `;
  ctx.addAffected(affected.map((x) => x.id));

  const tasks = chunk(affected, BATCH_SIZE).map((data, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getReportAgainstTasks', i + 1, 'of', tasks.length);

    const json = JSON.stringify(data);
    await updateScores(ctx, 'reportsAgainst')`
      SELECT
        CAST(j::json->>'id' as int) as "userId",
        CAST(j::json->>'violations' as int) * ${ctx.scoreMultipliers.reportsAgainst} as score
      FROM json_array_elements('${json}'::json) j
    `;
  });

  return tasks;
}

async function getUpdateTotalTasks(ctx: Context) {
  const tasks = chunk([...ctx.affected], BATCH_SIZE).map((ids, i) => async () => {
    await updateScores(ctx, 'total')`
      SELECT
        "userId",
        (
          COALESCE((meta->'scores'->>'models')::numeric, 0)
          + COALESCE((meta->'scores'->>'articles')::numeric, 0)
          + COALESCE((meta->'scores'->>'images')::numeric, 0)
          + COALESCE((meta->'scores'->>'users')::numeric, 0)
          + COALESCE((meta->'scores'->>'reportsActioned')::numeric, 0)
          + COALESCE((meta->'scores'->>'reportsAgainst')::numeric, 0)
        ) as score
      FROM "User"
      WHERE id IN (${ids})
    `;
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

async function getScoreMultipliers() {
  const data = await redis.packed.get<ScoreMultipliers>(REDIS_KEYS.SYSTEM.USER_SCORE_MULTIPLIERS);
  if (!data) throw new Error('User score multipliers not found in redis');
  return data;
}

async function timedExecution<T>(fn: (ctx: Context) => Promise<T>, ctx: Context) {
  const start = Date.now();
  await fn(ctx);
  return Date.now() - start;
}

function getAffected(ctx: Context) {
  return templateHandler(async (sql) => {
    const affectedQuery = await ctx.pg.cancellableQuery<{ id: number }>(sql);
    ctx.jobContext.on('cancel', affectedQuery.cancel);
    const affected = await affectedQuery.result();
    const ids = affected.map((x) => x.id);
    ctx.addAffected(ids);
    return ids;
  });
}

function executeRefresh(ctx: { pg: AugmentedPool; jobContext: JobContext }) {
  return templateHandler(async (sql) => {
    const query = await ctx.pg.cancellableQuery(sql);
    ctx.jobContext.on('cancel', query.cancel);
    await query.result();
  });
}

function updateScores(ctx: { pg: AugmentedPool }, target: keyof ScoreMultipliers | 'total') {
  return templateHandler(async (sql) => {
    const query = await ctx.pg.cancellableQuery(`
      WITH user_scores AS (
        ${sql}
      )
      UPDATE "User" u
        SET meta = jsonb_set(COALESCE(meta, '{}'), '{scores}', COALESCE(meta->'scores', '{}') || jsonb_build_object('${target}', score))
      FROM user_scores us
      WHERE u.id = us."userId";
    `);
    await query.result();
  });
}
// #endregion
