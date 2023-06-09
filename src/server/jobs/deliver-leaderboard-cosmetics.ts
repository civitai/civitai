import { createJob } from './job';
import { dbWrite } from '~/server/db/client';

export const deliverLeaderboardCosmetics = createJob(
  'deliver-leaderboard-cosmetics',
  '1 0 * * *',
  async () => {
    const [{ populated }] = await dbWrite.$queryRaw<{ populated: boolean }[]>`
      SELECT
        COUNT(DISTINCT "leaderboardId") = (SELECT COUNT(*) FROM "Leaderboard") as "populated"
      FROM "LeaderboardResult"
      WHERE date = current_date
    `;

    if (!populated) throw new Error('Leaderboard not populated');

    // deliver
    // --------------------------------------------
    await dbWrite.$executeRaw`
      -- Deliver leaderboard cosmetics
      with leaderboard_cosmetics AS (
        SELECT
          id,
          "leaderboardId",
          "leaderboardPosition"
        FROM "Cosmetic"
        WHERE "leaderboardId" IS NOT NULL
      )
      INSERT INTO "UserCosmetic"("userId", "cosmeticId", "obtainedAt")
      SELECT DISTINCT
        lr."userId",
        c.id,
        now()
      FROM "LeaderboardResult" lr
      JOIN leaderboard_cosmetics c ON
        c."leaderboardId" = lr."leaderboardId"
        AND lr.position <= c."leaderboardPosition"
        AND lr.date = current_date
      ON CONFLICT ("userId", "cosmeticId") DO NOTHING;
    `;

    // revoke
    // --------------------------------------------
    await dbWrite.$executeRaw`
      -- Revoke leaderboard cosmetics
      DELETE FROM "UserCosmetic" uc
      USING "Cosmetic" c
      WHERE c.id = uc."cosmeticId"
      AND c."leaderboardId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "LeaderboardResult" lr
        WHERE
          lr."leaderboardId" = c."leaderboardId"
          AND lr."userId" = uc."userId"
          AND lr.position <= c."leaderboardPosition"
          AND lr.date = current_date
      );
    `;
  }
);
