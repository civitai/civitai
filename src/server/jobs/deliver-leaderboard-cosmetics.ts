import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { isLeaderboardPopulated } from '~/server/services/leaderboard.service';

export const deliverLeaderboardCosmetics = createJob(
  'deliver-leaderboard-cosmetics',
  '1 0 * * *',
  async () => {
    if (!(await isLeaderboardPopulated())) throw new Error('Leaderboard not populated');

    await deliverSeasonCosmetics();
    await deliverLegendCosmetics();
  }
);

async function deliverSeasonCosmetics() {
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
    ON CONFLICT ("userId", "cosmeticId", "claimKey") DO NOTHING;
  `;

  // equip next best
  // --------------------------------------------
  await dbWrite.$executeRaw`
    -- Equip next best leaderboard cosmetic
    WITH equipped AS (
      SELECT
        uc."userId",
        c."leaderboardId",
        c."leaderboardPosition" cosmetic_position,
        lr.position current_position
      FROM "UserCosmetic" uc
      JOIN "Cosmetic" c ON uc."cosmeticId" = c.id
      LEFT JOIN "LeaderboardResult" lr ON lr."userId" = uc."userId"
        AND lr."leaderboardId" = c."leaderboardId"
        AND lr.date = current_date
      WHERE uc."equippedAt" IS NOT NULL AND uc."equippedToId" IS NULL
        AND lr.position > c."leaderboardPosition"
    ), next_best AS (
      SELECT
        uc."userId",
        uc."cosmeticId",
        ROW_NUMBER() OVER (PARTITION BY uc."userId" ORDER BY c."leaderboardPosition") AS rn
      FROM "UserCosmetic" uc
      JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
      JOIN equipped e ON e."leaderboardId" = c."leaderboardId" AND e."userId" = uc."userId"
      WHERE e.current_position <= c."leaderboardPosition"
        AND c."leaderboardPosition" > e.cosmetic_position
    )
    UPDATE "UserCosmetic" uc SET "equippedAt" = now()
    FROM next_best nb
    WHERE nb.rn = 1 AND nb."userId" = uc."userId" AND nb."cosmeticId" = uc."cosmeticId";
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

const LEGEND_COSMETIC_CUTOFF = 10;
async function deliverLegendCosmetics() {
  // deliver
  // --------------------------------------------
  await dbWrite.$executeRaw`
    -- Deliver leaderboard legend cosmetics
    WITH legends AS (
      SELECT DISTINCT "userId" FROM "LegendsBoardResult"
      WHERE position <= ${LEGEND_COSMETIC_CUTOFF}
    ), cosmetic AS (
      SELECT
        id
      FROM "Cosmetic"
      WHERE type = 'NamePlate'
      AND name = 'Legendary Nameplate'
    )
    INSERT INTO "UserCosmetic"("userId", "cosmeticId", "obtainedAt")
    SELECT
      l."userId",
      c.id,
      now()
    FROM legends l
    JOIN cosmetic c ON c.id IS NOT NULL
    ON CONFLICT ("userId", "cosmeticId", "claimKey") DO NOTHING;
  `;

  // revoke
  // --------------------------------------------
  await dbWrite.$executeRaw`
    -- Revoke leaderboard legend cosmetics
    WITH legends AS (
      SELECT DISTINCT "userId" FROM "LegendsBoardResult"
      WHERE position <= ${LEGEND_COSMETIC_CUTOFF}
    ), cosmetic AS (
        SELECT
          id
        FROM "Cosmetic"
        WHERE type = 'NamePlate'
        AND name = 'Legendary Nameplate'
    )
    DELETE FROM "UserCosmetic" uc
    USING cosmetic c
    WHERE uc."cosmeticId" = c.id AND uc."userId" NOT IN (SELECT "userId" FROM legends);
  `;
}
