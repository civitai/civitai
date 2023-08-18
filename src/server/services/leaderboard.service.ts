import { CosmeticSource, CosmeticType, Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { dbRead, dbWrite } from '~/server/db/client';
import { isModerator } from '~/server/routers/base.router';
import {
  GetLeaderboardInput,
  GetLeaderboardPositionsInput,
  GetLeaderboardsInput,
  GetLeaderboardsWithResultsInput,
} from '~/server/schema/leaderboard.schema';

export async function isLeaderboardPopulated() {
  const [{ populated }] = await dbWrite.$queryRaw<{ populated: boolean }[]>`
      SELECT
        COUNT(DISTINCT "leaderboardId") = (SELECT COUNT(*) FROM "Leaderboard") as "populated"
      FROM "LeaderboardResult"
      WHERE date = current_date
    `;

  return populated;
}

export async function getLeaderboards(input: GetLeaderboardsInput) {
  const leaderboards = await dbRead.leaderboard.findMany({
    where: {
      public: !input.isModerator ? true : undefined,
      active: true,
      id: input.ids
        ? {
            in: input.ids,
          }
        : undefined,
    },
    select: {
      id: true,
      title: true,
      description: true,
      scoringDescription: true,
      public: isModerator ? true : undefined,
    },
    orderBy: {
      index: 'asc',
    },
  });

  return leaderboards;
}

type LeaderboardPosition = {
  leaderboardId: string;
  position: number;
  score: number;
  metrics: Prisma.JsonValue;
};
export async function getLeaderboardPositions(input: GetLeaderboardPositionsInput) {
  const userId = input.userId;
  if (!userId) return [] as LeaderboardPosition[];

  // strip time from date
  let date = input.date ?? new Date();
  date = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const positions = await dbRead.leaderboardResult.findMany({
    where: {
      userId,
      date,
      leaderboard: !input.isModerator ? { public: true } : undefined,
      position: input.top ? { lte: input.top } : undefined,
    },
    select: {
      leaderboardId: true,
      position: true,
      score: true,
      metrics: true,
    },
  });

  return positions as LeaderboardPosition[];
}

const metricOrder = ['ratingCount', 'heart', 'downloadCount', 'viewCount', 'shots', 'hit', 'miss'];
type LeaderboardRaw = {
  userId: number;
  date: Date;
  position: number;
  score: number;
  metrics: Record<string, number>;
  username: string;
  deletedAt: Date | null;
  image: string | null;
  cosmetics:
    | {
        id: number;
        data: string;
        type: CosmeticType;
        source: CosmeticSource;
        name: string;
        leaderboardId: string;
        leaderboardPosition: number;
      }[]
    | null;
  delta: {
    position: number;
    score: number;
  } | null;
};
export async function getLeaderboard(input: GetLeaderboardInput) {
  const date = dayjs(input.date ?? dayjs().utc()).format('YYYY-MM-DD');

  const leaderboardResultsRaw = await dbRead.$queryRaw<LeaderboardRaw[]>`
    WITH yesterday AS MATERIALIZED (
      SELECT
        "userId",
        position,
        score
      FROM "LeaderboardResult"
      WHERE
        "leaderboardId" = ${input.id}
        AND "createdAt" = date(${date}) - interval '1 day'
        AND position < 2000
    )
    SELECT
      lr."userId",
      lr.date,
      lr.position,
      lr.score,
      lr.metrics,
      u.username,
      u."deletedAt",
      u.image,
      (
        SELECT
          jsonb_agg(jsonb_build_object(
            'id', c.id,
            'data', c.data,
            'type', c.type,
            'source', c.source,
            'name', c.name,
            'leaderboardId', c."leaderboardId",
            'leaderboardPosition', c."leaderboardPosition"
          ))
        FROM "UserCosmetic" uc
        JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
        AND "equippedAt" IS NOT NULL
        WHERE uc."userId" = lr."userId"
      ) cosmetics,
      (
        SELECT jsonb_build_object(
          'position', lr.position - lro.position,
          'score', lr.score - lro.score
        )
        FROM yesterday lro
        WHERE lro."userId" = lr."userId"
      ) delta
    FROM "LeaderboardResult" lr
    JOIN "Leaderboard" l ON l.id = lr."leaderboardId"
    JOIN "User" u ON u.id = lr."userId"
    WHERE lr.date = date(${date})
      AND lr."leaderboardId" = ${input.id}
      AND lr.position < ${input.maxPosition ?? 1000}
      ${Prisma.raw(!input.isModerator ? 'AND l.public = true' : '')}
    ORDER BY lr.position
  `;

  return leaderboardResultsRaw.map(
    ({ metrics: metricsRaw, userId, username, deletedAt, image, cosmetics, ...results }) => {
      const metrics = Object.entries(metricsRaw)
        .map(([type, value]) => ({
          type,
          value,
        }))
        .sort((a, b) => {
          const aIndex = metricOrder.indexOf(a.type);
          const bIndex = metricOrder.indexOf(b.type);
          if (aIndex === -1) return 1;
          if (bIndex === -1) return -1;
          return aIndex - bIndex;
        });

      return {
        ...results,
        user: {
          id: userId,
          username,
          deletedAt,
          image,
          cosmetics: cosmetics?.map((cosmetic) => ({ cosmetic })) ?? [],
        },
        metrics,
      };
    }
  );
}

export type LeaderboardWithResults = Awaited<ReturnType<typeof getLeaderboardsWithResults>>[number];

export async function getLeaderboardsWithResults(input: GetLeaderboardsWithResultsInput) {
  const { isModerator } = input;
  const leaderboards = await getLeaderboards(input);

  const leaderboardsWithResults = await Promise.all(
    leaderboards.map(async (leaderboard) => {
      const results = await getLeaderboard({
        id: leaderboard.id,
        isModerator,
        date: input.date,
        maxPosition: 5,
      });

      const cosmetics = await dbRead.cosmetic.findMany({
        select: {
          id: true,
          name: true,
          data: true,
          description: true,
          source: true,
          type: true,
          leaderboardPosition: true,
        },
        where: {
          leaderboardId: leaderboard.id,
        },
        orderBy: {
          leaderboardPosition: 'asc',
        },
      });

      return {
        ...leaderboard,
        cosmetics,
        results,
      };
    })
  );

  return leaderboardsWithResults;
}
