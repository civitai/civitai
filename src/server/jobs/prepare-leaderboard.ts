import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import dayjs from 'dayjs';
import { createLogger } from '~/utils/logging';
import { purgeCache } from '~/server/cloudflare/client';
import { applyDiscordLeaderboardRoles } from '~/server/jobs/apply-discord-roles';
import { updateLeaderboardRank } from '~/server/services/user.service';
import { isLeaderboardPopulated } from '~/server/services/leaderboard.service';
import { constants } from '~/server/common/constants';

const log = createLogger('leaderboard', 'blue');

const prepareLeaderboard = createJob('prepare-leaderboard', '0 23 * * *', async () => {
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
  for (const { id, query } of leaderboards) {
    log(`Started leaderboard ${id}`);
    const start = Date.now();
    await dbWrite.$executeRawUnsafe(`
      DELETE FROM "LeaderboardResult"
      WHERE "leaderboardId" = '${id}' AND date = current_date + interval '${addDays} days'
    `);
    log(`Cleared leaderboard ${id} - ${(Date.now() - start) / 1000}s`);

    const includesCTE = query.includes('WITH ');
    if (includesCTE && !query.includes('scores')) throw new Error('Query must include scores CTE');

    await dbWrite.$executeRawUnsafe(`
      ${includesCTE ? query : `WITH scores AS (${query})`}
      INSERT INTO "LeaderboardResult"("leaderboardId", "date", "userId", "score", "metrics", "position")
      SELECT
        '${id}' as "leaderboardId",
        current_date + interval '${addDays} days' as date,
        *,
        row_number() OVER (ORDER BY score DESC) as position
      FROM scores
    `);
    log(`Finished leaderboard ${id} - ${(Date.now() - start) / 1000}s`);
  }

  await updateLegendsBoardResults();

  await setLastRun();
});

async function updateLegendsBoardResults() {
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
        FROM "LeaderboardResult"
        WHERE date <= now()
          AND position < 100
        GROUP BY "userId", "leaderboardId"
      )
      SELECT
        *,
        cast(row_number() OVER (PARTITION BY "leaderboardId" ORDER BY score DESC) as int) position
      FROM scores;
    `,
  ]);
}

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

async function setCoverImageNsfwLevel() {
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
      meta = jsonb_set(meta, '{imageNsfw}', to_jsonb(COALESCE(level.nsfw, 'None')))
    FROM model_nsfw_level level
    WHERE level.id = m.id;
  `;
}

const clearLeaderboardCache = createJob('clear-leaderboard-cache', '0 0 * * *', async () => {
  await purgeCache({ tags: ['leaderboard'] });
});

export const leaderboardJobs = [
  prepareLeaderboard,
  updateUserLeaderboardRank,
  updateUserDiscordLeaderboardRoles,
  clearLeaderboardCache,
];
