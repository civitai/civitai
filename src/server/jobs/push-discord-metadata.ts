import { createJob, getJobDate } from './job';
import { dbRead } from '~/server/db/client';
import { discord } from '~/server/integrations/discord';
import { clickhouse } from '~/server/clickhouse/client';
import { Prisma } from '@prisma/client';

export const pushDiscordMetadata = createJob('push-discord-metadata', '14 1 * * *', async () => {
  const [lastUpdate, setLastUpdate] = await getJobDate('push-discord-metadata');

  // Step 1: Get userIds with recent images and their last image date from ClickHouse (fast)
  const imageActivityMap = new Map<number, Date>();
  if (clickhouse) {
    const imageActivity = await clickhouse.$query<{ userId: number; last_image: string }>`
      SELECT userId, max(createdAt) as last_image
      FROM images_created
      WHERE createdAt > ${lastUpdate}
      GROUP BY userId
    `;
    for (const row of imageActivity) {
      imageActivityMap.set(row.userId, new Date(row.last_image));
    }
  }

  // Step 2: Get userIds with recent model activity and their last upload date from Postgres (fast)
  const modelActivity = await dbRead.$queryRaw<{ userId: number; last_upload: Date }[]>`
    SELECT "userId", MAX(GREATEST("publishedAt", "lastVersionAt")) as last_upload
    FROM "Model"
    WHERE "publishedAt" > ${lastUpdate} OR "lastVersionAt" > ${lastUpdate}
    GROUP BY "userId"
  `;
  const modelActivityMap = new Map<number, Date>();
  for (const row of modelActivity) {
    modelActivityMap.set(row.userId, row.last_upload);
  }

  // Step 3: Combine unique userIds
  const activeUserIds = [...new Set([...imageActivityMap.keys(), ...modelActivityMap.keys()])];

  if (activeUserIds.length === 0) {
    setLastUpdate();
    return;
  }

  // Step 4: Get Discord metadata for active users (uses partial index on Account)
  const discordUsers = (await dbRead.$queryRaw`
    SELECT
      u.username,
      u.id as user_id,
      a.access_token,
      a.refresh_token,
      a.expires_at,
      u."createdAt" as user_since,
      um."uploadCount" as models_uploaded,
      ur."leaderboardRank" as rank
    FROM "User" u
    JOIN "Account" a ON a."userId" = u.id
      AND a.provider = 'discord'
      AND a.scope LIKE '%role_connections.write%'
    LEFT JOIN "UserMetric" um ON um."userId" = u.id AND um.timeframe = 'AllTime'
    LEFT JOIN "UserRank" ur ON ur."userId" = u.id AND ur."leaderboardRank" <= 100
    WHERE u.id IN (${Prisma.join(activeUserIds)})
  `) as Omit<UserMetadataResult, 'last_image' | 'last_upload'>[];

  // Step 5: Enrich with activity dates and push to Discord
  for (const user of discordUsers) {
    const metadata: UserMetadataResult = {
      ...user,
      last_image: imageActivityMap.get(user.user_id) ?? null,
      last_upload: modelActivityMap.get(user.user_id) ?? null,
    };
    await discord.pushMetadata(metadata);
  }

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
