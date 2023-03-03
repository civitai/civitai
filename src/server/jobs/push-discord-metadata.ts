import { createJob } from './job';
import { dbRead, dbWrite } from '~/server/db/client';
import { discord } from '~/server/integrations/discord';
import { env } from '~/env/server.mjs';

const METADATA_LAST_PUSHED = 'last-pushed-metadata';
export const pushDiscordMetadata = createJob('push-discord-metadata', '*/1 * * * *', async () => {
  // Get the last pushed time from keyValue
  const lastUpdated = new Date(
    ((
      await dbRead.keyValue.findUnique({
        where: { key: METADATA_LAST_PUSHED },
      })
    )?.value as number) ?? Date.now()
  ).toISOString();

  const userMetadata = (await dbRead.$queryRawUnsafe(`
    WITH changed_users AS (
      SELECT DISTINCT "userId" FROM (
        SELECT DISTINCT "userId" FROM "UserActivity" WHERE "userId" IS NOT NULL AND "createdAt" > '${lastUpdated}' AND activity = 'ModelDownload'
        UNION
        SELECT DISTINCT m."userId" FROM "UserActivity" ua JOIN "Model" m ON m.id = cast(ua.details->>'modelId' as int) WHERE ua."userId" IS NOT NULL AND ua."createdAt" > '${lastUpdated}' AND activity = 'ModelDownload'
        UNION
        SELECT DISTINCT "userId" FROM "ModelEngagement" WHERE "createdAt" > '${lastUpdated}' AND type = 'Favorite'
        UNION
        SELECT DISTINCT m."userId" FROM "ModelEngagement" me JOIN "Model" m ON me."modelId" = m.id WHERE me."createdAt" > '${lastUpdated}' AND me.type = 'Favorite'
        UNION
        SELECT DISTINCT "userId" FROM "Review" WHERE "createdAt" > '${lastUpdated}'
        UNION
        SELECT DISTINCT m."userId" FROM "Review" r JOIN "ModelVersion" mv ON mv.id = r."modelVersionId" JOIN "Model" m ON m.id = mv."modelId" WHERE r."createdAt" > '${lastUpdated}'
        UNION
        SELECT DISTINCT "userId" FROM "Model" WHERE "publishedAt" > '${lastUpdated}'
        UNION
        SELECT DISTINCT id "userId" FROM "User" WHERE "createdAt" > '${lastUpdated}'
        UNION
        SELECT DISTINCT u.id "userId" FROM "Purchase" p JOIN "User" u ON u."customerId" = p."customerId" WHERE p."createdAt" > '${lastUpdated}'
        UNION
        SELECT DISTINCT "userId" FROM "CustomerSubscription" WHERE "createdAt" > '${lastUpdated}'
      ) a
    ), ${metadataFetchScript}
    JOIN changed_users cu ON cu."userId" = u.id;
  `)) as UserMetadataResult[];

  for (const metadata of userMetadata) {
    await discord.pushMetadata(metadata);
  }

  // Update the last pushed time
  // --------------------------------------------
  await dbWrite?.keyValue.upsert({
    where: { key: METADATA_LAST_PUSHED },
    create: { key: METADATA_LAST_PUSHED, value: new Date().getTime() },
    update: { value: new Date().getTime() },
  });
});

const metadataFetchScript = `
  user_downloads AS (
    SELECT "userId", COUNT(*) count
    FROM "UserActivity"
    WHERE activity = 'ModelDownload'
    GROUP BY "userId"
  ), user_favorites AS (
    SELECT "userId", COUNT(*) count
    FROM "ModelEngagement"
    WHERE type = 'Favorite'
    GROUP BY "userId"
  ), user_donations AS (
    SELECT u.id, MAX(p."createdAt") last
    FROM "Purchase" p
    JOIN "User" u ON u."customerId" = p."customerId"
    WHERE "priceId" = '${env.STRIPE_DONATE_ID}'
    GROUP BY u.id
  ), user_images AS (
    SELECT "userId", COUNT(*) count, MAX("createdAt") last
    FROM "Image" i
    GROUP BY "userId"
  ), creator_stats AS (
    SELECT
      m."userId",
      SUM(mr."downloadCountAllTime") downloads,
      SUM(mr."ratingCountAllTime") reviews,
      SUM(mr."favoriteCountAllTime") favorites
    FROM "ModelRank" mr
    JOIN "Model" m ON m.id = mr."modelId"
    GROUP BY m."userId"
  ), creator_published  AS (
    SELECT m."userId", MAX(m."publishedAt") last
    FROM "Model" m
    WHERE m."publishedAt" IS NOT NULL
    GROUP BY m."userId"
  )
  SELECT
    u.username,
    u.id user_id,
    a.access_token,
    a.refresh_token,
    a.expires_at,
    COALESCE(ud.count, 0)::int models_downloaded,
    COALESCE(uf.count, 0)::int models_favorited,
    COALESCE(um."reviewCount", 0)::int models_reviewed,
    u."createdAt" user_since,
    u."isModerator" moderator,
    cs.id IS NOT NULL supporter,
    cs."createdAt" supporter_since,
    user_donations.id IS NOT NULL donator,
    user_donations.last last_donation,
    COALESCE(ui.count, 0)::int images,
    ui.last last_image,
    COALESCE(um."uploadCount", 0) models_uploaded,
    cp.last last_upload,
    COALESCE(crs.favorites, 0)::int received_favorites,
    COALESCE(crs.reviews, 0)::int received_reviews,
    COALESCE(crs.downloads, 0)::int received_downloads,
    COALESCE(ur."leaderboardRank", 101)::int rank
  FROM "User" u
  JOIN "Account" a ON a."userId" = u.id AND a.provider = 'discord' AND scope LIKE '%role_connections.write%'
  LEFT JOIN "UserMetric" um ON um."userId" = u.id AND um.timeframe = 'AllTime'
  LEFT JOIN user_downloads ud ON ud."userId" = u.id
  LEFT JOIN user_favorites uf ON uf."userId" = u.id
  LEFT JOIN "CustomerSubscription" cs ON cs."userId" = u.id AND cs.status = 'active'
  LEFT JOIN "UserRank" ur ON ur."userId" = u.id AND ur."leaderboardRank" <= 100
  LEFT JOIN user_donations ON user_donations.id = u.id
  LEFT JOIN user_images ui ON ui."userId" = u.id
  LEFT JOIN creator_stats crs ON crs."userId" = u.id
  LEFT JOIN creator_published cp ON cp."userId" = u.id`;

export async function getUserDiscordMetadata(userId: number): Promise<UserMetadataResult> {
  const results = (await dbRead?.$queryRawUnsafe(`
    WITH ${metadataFetchScript}
    WHERE u.id = ${userId}
  `)) as UserMetadataResult[];

  return results[0];
}

type UserMetadataResult = {
  username: string;
  user_id: number;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  models_downloaded: number;
  models_favorited: number;
  models_reviewed: number;
  user_since: Date;
  moderator: boolean;
  supporter: boolean;
  supporter_since: Date | null;
  donator: boolean;
  last_donation: Date | null;
  images: number;
  last_image: Date | null;
  models_uploaded: number;
  last_upload: Date | null;
  received_favorites: number;
  received_reviews: number;
  received_downloads: number;
  rank: number | null;
};
