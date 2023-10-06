import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import dayjs from 'dayjs';
import { createLogger } from '~/utils/logging';
import { purgeCache } from '~/server/cloudflare/client';
import { applyDiscordLeaderboardRoles } from '~/server/jobs/apply-discord-roles';
import { updateLeaderboardRank } from '~/server/services/user.service';
import { isLeaderboardPopulated } from '~/server/services/leaderboard.service';

const log = createLogger('leaderboard', 'blue');

const prepareLeaderboard = createJob('prepare-leaderboard', '0 23 * * *', async () => {
  const [lastRun, setLastRun] = await getJobDate('prepare-leaderboard');

  await setModelCoverImageNsfwLevel();

  const leaderboards = await dbWrite.leaderboard.findMany({
    where: {
      active: true,
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
    await dbWrite.$executeRawUnsafe(`
      WITH scores AS (
        ${query}
      )
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

  await setLastRun();
});

const updateUserLeaderboardRank = createJob(
  'update-user-leaderboard-rank',
  '1 0 * * *',
  async () => {
    if (!(await isLeaderboardPopulated())) throw new Error('Leaderboard not populated');
    await updateLeaderboardRank();
  }
);

const updateUserDiscordLeaderboardRoles = createJob(
  'update-user-leaderboard-rank',
  '10 0 * * *',
  async () => {
    if (!(await isLeaderboardPopulated())) throw new Error('Leaderboard not populated');
    await applyDiscordLeaderboardRoles();
  }
);

async function setModelCoverImageNsfwLevel() {
  await dbWrite.$executeRaw`
    -- set model nsfw image level based on post nsfw level
    WITH model_nsfw_level AS (
      SELECT DISTINCT ON (m.id) m.id, p.metadata->>'imageNsfw' nsfw
      FROM "Model" m
      JOIN "ModelVersion" mv ON mv."modelId" = m.id AND mv.status = 'Published'
      JOIN "Post" p ON p."modelVersionId" = mv.id AND p."userId" = m."userId"
      WHERE m.status = 'Published'
      ORDER BY m.id, mv.index, p.id
    )
    UPDATE "Model" m
    SET
      meta = CASE
        WHEN jsonb_typeof(meta) = 'null' THEN jsonb_build_object('imageNsfw', COALESCE(mnl.nsfw, 'None'))
        ELSE m.meta || jsonb_build_object('imageNsfw', COALESCE(mnl.nsfw, 'None'))
      END
    FROM model_nsfw_level mnl
    WHERE mnl.id = m.id;
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
