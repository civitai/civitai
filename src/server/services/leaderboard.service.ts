import dayjs from 'dayjs';
import { dbRead } from '~/server/db/client';
import { isModerator } from '~/server/routers/base.router';
import {
  GetLeaderboardInput,
  GetLeaderboardPositionsInput,
} from '~/server/schema/leaderboard.schema';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

type IsMod = { isModerator: boolean };

export async function getLeaderboards(input: IsMod) {
  const leaderboards = await dbRead.leaderboard.findMany({
    where: {
      public: input.isModerator ? true : undefined,
      active: true,
    },
    select: {
      id: true,
      index: true,
      title: true,
      description: true,
      scoringDescription: true,
      public: isModerator ? true : undefined,
    },
  });

  return leaderboards;
}

export async function getLeaderboardPositions(input: GetLeaderboardPositionsInput & IsMod) {
  const userId = input.userId;
  // strip time from date
  let date = input.date ?? new Date();
  date = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const positions = await dbRead.leaderboardResult.findMany({
    where: {
      userId,
      date,
      leaderboard: input.isModerator ? { public: true } : undefined,
    },
    select: {
      leaderboardId: true,
      position: true,
      score: true,
      metrics: true,
    },
  });

  return positions;
}

export async function getLeaderboard(input: GetLeaderboardInput & IsMod) {
  let date = input.date ?? new Date();
  date = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const leaderboardResults = await dbRead.leaderboardResult.findMany({
    where: {
      date,
      leaderboardId: input.id,
      leaderboard: input.isModerator ? { public: true } : undefined,
    },
    select: {
      userId: true,
      user: {
        select: userWithCosmeticsSelect,
      },
      position: true,
      score: true,
      metrics: true,
    },
    orderBy: {
      position: 'asc',
    },
  });

  return leaderboardResults;
}
