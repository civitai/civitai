import dayjs from 'dayjs';
import { purgeCache } from '~/server/cloudflare/client';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { pgDbWrite } from '~/server/db/pgDb';
import { applyDiscordLeaderboardRoles } from '~/server/jobs/apply-discord-roles';
import { logToAxiom } from '~/server/logging/client';
import { isLeaderboardPopulated } from '~/server/services/leaderboard.service';
import { updateLeaderboardRank } from '~/server/services/user.service';
import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import { createJob, getJobDate, JobContext } from './job';

const log = createLogger('leaderboard', 'blue');

const prepareLeaderboard = createJob('prepare-leaderboard', '0 23 * * *', async (jobContext) => {
  const [lastRun, setLastRun] = await getJobDate('prepare-leaderboard');

  await setCoverImageNsfwLevel();

  const leaderboards = await dbWrite.leaderboard.findMany({
    where: {
      active: true,
      query: { not: '' },
    },
    select: {
      id: true,
      query: true,
    },
  });

  // Get latest results for date
  const addDays = dayjs().utc().hour() >= 23 ? 1 : 0;
  let imageRange: [number, number] | undefined;
  log('Leaderboards - Starting');
  const tasks = leaderboards.map(({ id, query }) => async () => {
    jobContext.checkIfCanceled();
    const hasDataQuery = await pgDbWrite.query<{ count: number }>(`
      SELECT COUNT(*) as count FROM "LeaderboardResult"
      WHERE "leaderboardId" = '${id}' AND date = current_date + interval '${addDays} days'
    `);
    const hasData = hasDataQuery.rows[0].count > 0;
    if (hasData) {
      log(`Leaderboard ${id} - Previously completed`);
      return;
    }

    const includesCTE = query.includes('WITH ');
    const context = { jobContext, id, query, includesCTE, addDays };

    const start = Date.now();
    log(`Leaderboard ${id} - Starting`);

    if (includesCTE && query.includes('image_scores AS')) {
      if (!imageRange) imageRange = await getImageRange();
      await imageLeaderboardPopulation(context, imageRange);
    } else {
      if (includesCTE && !query.includes('scores'))
        throw new Error('Query must include scores CTE');
      await defaultLeadboardPopulation(context);
    }

    log(`Leaderboard ${id} - Done - ${(Date.now() - start) / 1000}s`);
  });
  try {
    await limitConcurrency(tasks, 3);
    log('Leaderboards - Done');
    await updateLegendsBoardResults();
    await setLastRun();
  } catch (e) {
    const error = e as Error;
    logToAxiom({ type: 'leaderboard-error', message: error.message }).catch();
    throw error;
  }
});

async function updateLegendsBoardResults() {
  log('Legends Board - Starting');
  await dbWrite.$transaction([
    dbWrite.$executeRaw`DROP TABLE IF EXISTS "LegendsBoardResult";`,
    dbWrite.$executeRaw`
      CREATE TABLE "LegendsBoardResult" AS
      WITH scores AS (
        SELECT
          "userId",
          "leaderboardId",
          SUM(CASE
            WHEN position <= 1 THEN ${constants.leaderboard.legendScoring.diamond}
            WHEN position <= 3 THEN ${constants.leaderboard.legendScoring.gold}
            WHEN position <= 10 THEN ${constants.leaderboard.legendScoring.silver}
            WHEN position <= 100 THEN ${constants.leaderboard.legendScoring.bronze}
          END) * 100 score,
          jsonb_build_object(
            'diamond', SUM(IIF(position<=1, 1, 0)),
            'gold', SUM(IIF(position BETWEEN 2 AND 3, 1, 0)),
            'silver', SUM(IIF(position BETWEEN 4 AND 10, 1, 0)),
            'bronze', SUM(IIF(position BETWEEN 11 AND 100, 1, 0))
          ) metrics
        FROM "LeaderboardResult" lr
        JOIN "User" u ON u.id = lr."userId"
        WHERE date <= now()
          AND position < 100
          AND u."deletedAt" IS NULL
        GROUP BY "userId", "leaderboardId"
      )
      SELECT
        *,
        cast(row_number() OVER (PARTITION BY "leaderboardId" ORDER BY score DESC) as int) position
      FROM scores;
    `,
  ]);
  log('Legends Board - Done');
}

type LeaderboardContext = {
  jobContext: JobContext;
  id: string;
  query: string;
  includesCTE: boolean;
  addDays?: number;
};

const updateUserLeaderboardRank = createJob(
  'update-user-leaderboard-rank',
  '1 0 * * *',
  async () => {
    if (!(await isLeaderboardPopulated())) throw new Error('Leaderboard not populated');
    await updateLeaderboardRank();
  }
);

const updateUserDiscordLeaderboardRoles = createJob(
  'update-user-discord-leaderboard-roles',
  '10 0 * * *',
  async () => {
    if (!(await isLeaderboardPopulated())) throw new Error('Leaderboard not populated');
    await applyDiscordLeaderboardRoles();
  }
);

async function defaultLeadboardPopulation(ctx: LeaderboardContext) {
  const leaderboardUpdateQuery = await pgDbWrite.cancellableQuery(`
    ${ctx.includesCTE ? ctx.query : `WITH scores AS (${ctx.query})`}
    INSERT INTO "LeaderboardResult"("leaderboardId", "date", "userId", "score", "metrics", "position")
    SELECT
      '${ctx.id}' as "leaderboardId",
      current_date + interval '${ctx.addDays} days' as date,
      *,
      row_number() OVER (ORDER BY score DESC) as position
    FROM scores
    ORDER BY score DESC
    LIMIT 1000
  `);
  ctx.jobContext.on('cancel', leaderboardUpdateQuery.cancel);
  await leaderboardUpdateQuery.result();
}

async function getImageRange() {
  const {
    rows: [{ min, max }],
  } = await pgDbWrite.query<{ min: number; max: number }>(`
    WITH dates AS (
      SELECT MIN("createdAt") as start, MAX("createdAt") as end FROM "Image" WHERE "createdAt" > now() - interval '30 days'
    )
    SELECT MIN(id) as min, MAX(id) as max
    FROM "Image" i
    JOIN dates d ON d.start = i."createdAt" OR d.end = i."createdAt";
  `);
  return [min, max] as [number, number];
}

type ImageScores = {
  imageId: number;
  userId: number;
  score: number;
  metrics: Record<string, number>;
};
const IMAGE_SCORE_BATCH_SIZE = 10000;
const IMAGE_SCORE_FALLOFF = 120;
const IMAGE_SCORE_MULTIPLIER = 100;
async function imageLeaderboardPopulation(ctx: LeaderboardContext, [min, max]: [number, number]) {
  // Fetch Scores
  let scores: ImageScores[] = [];
  const tasks: Task[] = [];
  const numTasks = Math.ceil((max - min) / IMAGE_SCORE_BATCH_SIZE);
  log(`Leaderboard ${ctx.id} - Fetching scores - ${numTasks} tasks`);
  for (let i = 0; i < numTasks; i++) {
    const startIndex = min + i * IMAGE_SCORE_BATCH_SIZE;
    const endIndex = Math.min(startIndex + IMAGE_SCORE_BATCH_SIZE - 1, max);

    tasks.push(async () => {
      ctx.jobContext.checkIfCanceled();
      const key = `Leaderboard ${ctx.id} - Fetching scores - ${startIndex} to ${endIndex}`;
      log(key);
      // console.time(key);
      const batchScores = await pgDbWrite.query<ImageScores>(
        `${ctx.query} SELECT * FROM image_scores`,
        [startIndex, endIndex]
      );
      // console.timeEnd(key);
      scores.push(...batchScores.rows);
    });
  }
  await limitConcurrency(tasks, 5);

  // Add up scores
  log(`Leaderboard ${ctx.id} - Adding up scores`);
  scores = scores.sort((a, b) => b.score - a.score);
  const userScores: Record<number, { score: number; metrics: Record<string, number> }> = {};
  for (const score of scores) {
    // Build user score
    if (!userScores[score.userId])
      userScores[score.userId] = { score: 0, metrics: { imageCount: 0 } };

    // Add score
    userScores[score.userId].metrics.imageCount++;
    const entryRank = userScores[score.userId].metrics.imageCount;
    const quantityMultiplier = Math.max(0, 1 - Math.pow(entryRank / IMAGE_SCORE_FALLOFF, 0.5));
    userScores[score.userId].score += score.score * quantityMultiplier;

    // Add up metrics
    for (const metric in score.metrics) {
      if (!userScores[score.userId].metrics[metric]) userScores[score.userId].metrics[metric] = 0;
      userScores[score.userId].metrics[metric] += score.metrics[metric];
    }
  }

  // Apply multipliers and sqrt
  for (const userId in userScores) {
    userScores[userId].score = Math.round(
      Math.sqrt(userScores[userId].score) * IMAGE_SCORE_MULTIPLIER
    );
  }

  // Rank
  const userScoresArray = Object.entries(userScores)
    .map(([userId, score]) => ({
      userId: parseInt(userId),
      ...score,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 1100);

  // Insert into leaderboard
  log(`Leaderboard ${ctx.id} - Inserting into leaderboard`);
  // console.time(`Leaderboard ${ctx.id} - Inserting into leaderboard`);
  const userScoresJson = JSON.stringify(userScoresArray);
  const leaderboardUpdateQuery = await pgDbWrite.cancellableQuery(`
    INSERT INTO "LeaderboardResult"("leaderboardId", "date", "userId", "score", "metrics", "position")
    SELECT
      '${ctx.id}' as "leaderboardId",
      current_date + interval '${ctx.addDays} days' as date,
      (s->>'userId')::int,
      (s->>'score')::int,
      (s->>'metrics')::jsonb,
      row_number() OVER (ORDER BY (s->>'score')::int DESC) as position
    FROM jsonb_array_elements('${userScoresJson}'::jsonb) s
    JOIN "User" u ON u.id = (s->>'userId')::int
    WHERE u."deletedAt" IS NULL AND u.id > 0
    ORDER BY (s->>'score')::int DESC
    LIMIT 1000
  `);
  ctx.jobContext.on('cancel', leaderboardUpdateQuery.cancel);
  await leaderboardUpdateQuery.result();
  // console.timeEnd(`Leaderboard ${ctx.id} - Inserting into leaderboard`);
}

async function setCoverImageNsfwLevel() {
  log('Setting cover image nsfw level - version');
  await dbWrite.$executeRaw`
    -- set version nsfw image level based on post nsfw level
    WITH model_version_nsfw_level AS (
      SELECT DISTINCT ON (mv.id) mv.id, p.metadata->>'imageNsfw' nsfw
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      JOIN "Post" p ON p."modelVersionId" = mv.id AND p."userId" = m."userId"
      WHERE mv.status = 'Published'
      ORDER BY mv.id, mv.index, p.id
    )
    UPDATE "ModelVersion" mv
    SET
      meta = jsonb_set(meta, '{imageNsfw}', to_jsonb(COALESCE(level.nsfw, 'None')))
    FROM model_version_nsfw_level level
    WHERE level.id = mv.id;
  `;

  log('Setting cover image nsfw level - model');
  await dbWrite.$executeRaw`
    -- set model nsfw image level based on version nsfw level
    WITH model_nsfw_level AS (
      SELECT DISTINCT ON (mv."modelId")
        mv."modelId" as "id",
        mv.meta->>'imageNsfw' nsfw
      FROM "ModelVersion" mv
      ORDER BY mv."modelId", mv.index
    )
    UPDATE "Model" m
    SET
      meta = CASE
        WHEN jsonb_typeof(meta) = 'null' THEN jsonb_build_object('imageNsfw', COALESCE(level.nsfw, 'None'))
        ELSE m.meta || jsonb_build_object('imageNsfw', COALESCE(level.nsfw, 'None'))
      END
    FROM model_nsfw_level level
    WHERE level.id = m.id;
  `;
}

const clearLeaderboardCache = createJob('clear-leaderboard-cache', '0 0 * * *', async () => {
  await purgeCache({ tags: ['leaderboard'] });
  await purgeCache({ tags: ['image-resources'] });
});

export const leaderboardJobs = [
  prepareLeaderboard,
  updateUserLeaderboardRank,
  updateUserDiscordLeaderboardRoles,
  clearLeaderboardCache,
];
