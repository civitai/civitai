import { createJob, getJobDate } from './job';
import { dbRead } from '~/server/db/client';
import { discord } from '~/server/integrations/discord';

export const pushDiscordMetadata = createJob('push-discord-metadata', '14 1 * * *', async () => {
  const [lastUpdate, setLastUpdate] = await getJobDate('push-discord-metadata');
  const userMetadata = (await dbRead.$queryRaw`
    WITH updates AS (
      SELECT 'image' as type, "userId", MAX("createdAt") as last
      FROM "Image"
      WHERE "createdAt" > ${lastUpdate}
      GROUP BY "userId"

      UNION

      SELECT 'model' as type, "userId", MAX(GREATEST("publishedAt","lastVersionAt")) as last
      FROM "Model"
      WHERE "publishedAt" > ${lastUpdate} OR "lastVersionAt" > ${lastUpdate}
      GROUP BY "userId"
    ), discord_users AS (
      SELECT
        u.username,
        u.id user_id,
        a.access_token,
        a.refresh_token,
        a.expires_at,
        u."createdAt" user_since
      FROM "User" u
      JOIN "Account" a ON a."userId" = u.id AND a.provider = 'discord' AND scope LIKE '%role_connections.write%'
      WHERE u.id IN (SELECT "userId" FROM updates)
    )
    SELECT
      du.username,
      du.user_id,
      du.access_token,
      du.refresh_token,
      du.expires_at,
      du.user_since,
      ui.last last_image,
      um."uploadCount" models_uploaded,
      cp.last last_upload,
      ur."leaderboardRank" rank
    FROM discord_users du
    LEFT JOIN "UserMetric" um ON um."userId" = du.user_id AND um.timeframe = 'AllTime'
    LEFT JOIN "UserRank" ur ON ur."userId" = du.user_id AND ur."leaderboardRank" <= 100
    JOIN updates ui ON ui."userId" = du.user_id AND ui.type = 'image'
    JOIN updates cp ON cp."userId" = du.user_id AND cp.type = 'model';
  `) as UserMetadataResult[];

  for (const metadata of userMetadata) await discord.pushMetadata(metadata);
  setLastUpdate();
});

export async function getUserDiscordMetadata(userId: number): Promise<UserMetadataResult> {
  const results = (await dbRead.$queryRaw`
     WITH user_images AS (
      SELECT "userId", MAX("createdAt") last
      FROM "Image" i
      WHERE "userId" = ${userId}
      GROUP BY "userId"
    ), creator_published  AS (
      SELECT m."userId", MAX(GREATEST(m."publishedAt",m."lastVersionAt")) last
      FROM "Model" m
      WHERE m."publishedAt" IS NOT NULL AND "userId" = ${userId}
      GROUP BY m."userId"
    )
    SELECT
      u.username,
      u.id user_id,
      a.access_token,
      a.refresh_token,
      a.expires_at,
      u."createdAt" user_since,
      ui.last last_image,
      um."uploadCount" models_uploaded,
      cp.last last_upload,
      ur."leaderboardRank" rank
    FROM "User" u
    JOIN "Account" a ON a."userId" = u.id AND a.provider = 'discord' AND scope LIKE '%role_connections.write%'
    LEFT JOIN "UserMetric" um ON um."userId" = u.id AND um.timeframe = 'AllTime'
    LEFT JOIN "UserRank" ur ON ur."userId" = u.id AND ur."leaderboardRank" <= 100
    LEFT JOIN user_images ui ON ui."userId" = u.id
    LEFT JOIN creator_published cp ON cp."userId" = u.id
    WHERE u.id = ${userId}
  `) as UserMetadataResult[];

  return results[0];
}

type UserMetadataResult = {
  username: string;
  user_id: number;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user_since: Date;
  last_image: Date | null;
  models_uploaded: number;
  last_upload: Date | null;
  rank: number | null;
};
