import { Prisma } from '@prisma/client';
import type { CosmeticSource, CosmeticType } from '~/shared/utils/prisma/enums';
import { DomainColor } from '~/shared/utils/prisma/enums';
import dayjs from '~/shared/utils/dayjs';
import { dbRead, dbWrite } from '~/server/db/client';
import { isModerator } from '~/server/routers/base.router';
import type {
  GetLeaderboardInput,
  GetLeaderboardPositionsInput,
  GetLeaderboardsInput,
  GetLeaderboardsWithResultsInput,
} from '~/server/schema/leaderboard.schema';
import { getCosmeticsForUsers, getProfilePicturesForUsers } from '~/server/services/user.service';

export async function isLeaderboardPopulated() {
  const [{ populated }] = await dbWrite.$queryRaw<{ populated: boolean }[]>`
      SELECT (
        SELECT
          COUNT(DISTINCT lr."leaderboardId")
        FROM "LeaderboardResult" lr
        JOIN "Leaderboard" l ON l.id = lr."leaderboardId"
        WHERE l.query != '' AND date = current_date::date
      ) = (SELECT COUNT(*) FROM "Leaderboard" WHERE query != '' AND active) as "populated"
    `;

  return populated;
}

// A board is visible on a domain when its `domain` array contains that color or
// `all`. An unresolved domain sees only `all` boards — fail closed, so a board
// scoped to red never leaks onto an unrecognized host.
export function domainVisibilityFilter(domain?: DomainColor) {
  return { hasSome: domain ? [DomainColor.all, domain] : [DomainColor.all] };
}

export async function getLeaderboards(input: GetLeaderboardsInput) {
  const leaderboards = await dbRead.leaderboard.findMany({
    where: {
      public: !input.isModerator ? true : undefined,
      active: true,
      domain: domainVisibilityFilter(input.domain),
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
      leaderboard: {
        domain: domainVisibilityFilter(input.domain),
        ...(!input.isModerator ? { public: true } : {}),
      },
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
        data: MixedObject | null;
        cosmetic: {
          id: number;
          data: string;
          type: CosmeticType;
          source: CosmeticSource;
          name: string;
          leaderboardId: string;
          leaderboardPosition: number;
        };
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
    WITH yesterday AS (
      SELECT
        "userId",
        position,
        score
      FROM "LeaderboardResult"
      WHERE
        "leaderboardId" = ${input.id}
        AND "date" = date(${date}) - interval '1 day'
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
      AND l.domain && ${domainVisibilityFilter(input.domain).hasSome}::"DomainColor"[]
      ${Prisma.raw(!input.isModerator ? 'AND l.public = true' : '')}
    ORDER BY lr.position
  `;

  return await formatLeaderboardResults(leaderboardResultsRaw, metricOrder);
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
        domain: input.domain,
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

const legendsMetricOrder = ['diamond', 'gold', 'silver', 'bronze'];
export async function getLeaderboardLegends(input: GetLeaderboardInput) {
  const leaderboardResultsRaw = await dbRead.$queryRaw<LeaderboardRaw[]>`
    WITH scores AS (
      SELECT
        lbr."userId",
        lbr.score,
        lbr.metrics,
        lbr.position
      FROM "LegendsBoardResult" lbr
      JOIN "Leaderboard" l ON l.id = lbr."leaderboardId"
      WHERE lbr."leaderboardId" = ${input.id}
        AND l.domain && ${domainVisibilityFilter(input.domain).hasSome}::"DomainColor"[]
    )
    SELECT
      s."userId",
      current_date date,
      s.position,
      s.score,
      s.metrics,
      u.username,
      u."deletedAt",
      u.image,
      null delta
    FROM scores s
    JOIN "User" u ON u.id = s."userId"
    ORDER BY s.score DESC
  `;

  return await formatLeaderboardResults(leaderboardResultsRaw, legendsMetricOrder);
}

async function formatLeaderboardResults(results: LeaderboardRaw[], metricSortOrder = metricOrder) {
  const userIds = results.map((r) => r.userId);
  const [profilePictures, cosmetics] = await Promise.all([
    getProfilePicturesForUsers(userIds),
    getCosmeticsForUsers(userIds),
  ]);

  return results.map(({ metrics: metricsRaw, userId, username, deletedAt, image, ...results }) => {
    const metrics = Object.entries(metricsRaw)
      .map(([type, value]) => ({
        type,
        value,
      }))
      .sort((a, b) => {
        const aIndex = metricSortOrder.indexOf(a.type);
        const bIndex = metricSortOrder.indexOf(b.type);
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
        cosmetics: cosmetics[userId] ?? [],
        profilePicture: profilePictures[userId] ?? null,
      },
      metrics,
    };
  });
}
