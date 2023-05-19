import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import dayjs from 'dayjs';

export const prepareLeaderboard = createJob('prepare-leaderboard', '0 23 * * *', async () => {
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
  const now = dayjs();
  const lastRanYesterday = lastRun && dayjs(lastRun).isSame(now.subtract(1, 'day'), 'day');
  const addDays = lastRanYesterday ? 1 : 0;
  for (const { id, query } of leaderboards) {
    await dbWrite.$transaction([
      dbWrite.$executeRawUnsafe(`
        DELETE FROM "LeaderboardResult"
        WHERE "leaderboardId" = '${id}' AND date = current_date + interval '${addDays} days'
      `),
      dbWrite.$executeRawUnsafe(`
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
        ORDER BY position
      `),
    ]);
  }

  await setLastRun();
});

export const updateUserLeaderboardRank = createJob(
  'update-user-leaderboard-rank',
  '1 0 * * *',
  async () => {
    await dbWrite.$transaction([
      dbWrite.$executeRaw`
      UPDATE "UserRank" SET "leaderboardRank" = null, "leaderboardId" = null, "leaderboardTitle" = null;
    `,
      dbWrite.$executeRaw`
      INSERT INTO "UserRank" ("userId", "leaderboardRank", "leaderboardId", "leaderboardTitle")
      SELECT
        "userId",
        "leaderboardRank",
        "leaderboardId",
        "leaderboardTitle"
      FROM "UserRank_Live"
      ON CONFLICT ("userId") DO UPDATE SET
        "leaderboardId" = excluded."leaderboardId",
        "leaderboardRank" = excluded."leaderboardRank",
        "leaderboardTitle" = excluded."leaderboardTitle";
    `,
    ]);
  }
);

async function setModelCoverImageNsfwLevel() {
  await dbWrite.$executeRaw`
    -- set model nsfw image level
    WITH model_images AS (
      SELECT
        m.id,
        i.nsfw,
        row_number() OVER (PARTITION BY m.id ORDER BY mv.index, i."postId", i.index) row_num
      FROM "Model" m
      JOIN "ModelVersion" mv ON mv."modelId" = m.id
      JOIN "Post" p ON p."modelVersionId" = mv.id AND p."userId" = m."userId"
      JOIN "Image" i ON i."postId" = p.id
    ), model_nsfw_level AS (
      SELECT
        id,
        nsfw
      FROM model_images
      WHERE row_num = 1
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
