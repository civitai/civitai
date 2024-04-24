import { getTRPCErrorFromUnknown } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import { redis } from '~/server/redis/client';
import { TransactionType } from '~/server/schema/buzz.schema';
import { EventInput, TeamScoreHistoryInput } from '~/server/schema/event.schema';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { getCosmeticDetail } from '~/server/services/cosmetic.service';
import { cosmeticStatus } from '~/server/services/user.service';

export async function getEventData({ event }: EventInput) {
  try {
    return await eventEngine.getEventData(event);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export function getTeamScores({ event }: EventInput) {
  try {
    return eventEngine.getTeamScores(event);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export function getTeamScoreHistory(input: TeamScoreHistoryInput) {
  try {
    return eventEngine.getTeamScoreHistory(input);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

type EventCosmetic = Awaited<ReturnType<typeof cosmeticStatus>> & {
  cosmetic: Awaited<ReturnType<typeof getCosmeticDetail>>;
};
export async function getEventCosmetic({ event, userId }: EventInput & { userId: number }) {
  try {
    // TODO optimize, let's cache this to avoid multiple queries
    const cacheJson = await redis.hGet(`event:${event}:cosmetic`, userId.toString());
    if (cacheJson) return JSON.parse(cacheJson) as EventCosmetic;

    const { cosmeticId } = await eventEngine.getUserData({ event, userId });
    if (!cosmeticId)
      return { available: false, obtained: false, equipped: false, data: {}, cosmetic: null };

    const cosmetic = await getCosmeticDetail({ id: cosmeticId });
    const status = await cosmeticStatus({ id: cosmeticId, userId });
    // Get the userCosmetic record so we can display the data

    const result: EventCosmetic = { ...status, cosmetic };
    await redis.hSet(`event:${event}:cosmetic`, userId.toString(), JSON.stringify(result));

    return result;
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getEventPartners({ event }: EventInput) {
  try {
    return eventEngine.getPartners(event);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function activateEventCosmetic({ event, userId }: EventInput & { userId: number }) {
  try {
    // Get cosmetic
    const { cosmeticId, team } = await eventEngine.getUserData({ event, userId });
    if (!cosmeticId) throw new Error("You don't have a cosmetic for this event");
    const cosmetic = await getCosmeticDetail({ id: cosmeticId });
    if (!cosmetic) throw new Error("That cosmetic doesn't exist");

    // Update database
    await dbWrite.$executeRaw`
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "obtainedAt", "equippedAt")
      VALUES (${userId}, ${cosmeticId}, NOW(), NOW())
      ON CONFLICT ("userId", "cosmeticId") DO UPDATE SET "equippedAt" = NOW()
    `;

    const { data } = (await dbWrite.userCosmetic.findUnique({
      where: { userId_cosmeticId_claimKey: { userId, cosmeticId, claimKey: 'claimed' } },
      select: { data: true },
    })) ?? { data: {} };

    // Update cache
    await redis.hSet(
      `event:${event}:cosmetic`,
      userId.toString(),
      JSON.stringify({ equipped: true, available: true, obtained: true, data, cosmetic })
    );

    // Queue adding to role
    await eventEngine.queueAddRole({ event, team, userId });

    return { cosmetic };
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function donate({
  event,
  userId,
  amount,
}: EventInput & { userId: number; amount: number }) {
  try {
    const result = await eventEngine.donate(event, { userId, amount });
    return result;
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getEventRewards({ event }: EventInput) {
  try {
    return eventEngine.getRewards(event);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getEventContributors({ event }: EventInput) {
  try {
    const contributors = await eventEngine.getTopContributors(event);
    const userIds = new Set<number>();
    for (const team of Object.values(contributors.teams)) {
      for (const user of team) userIds.add(user.userId);
    }
    for (const user of contributors.allTime) userIds.add(user.userId);
    for (const user of contributors.day) userIds.add(user.userId);

    const users = await dbRead.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, username: true, image: true },
    });
    const userMap = new Map(users.map((user) => [user.id, user]));

    return {
      allTime: contributors.allTime.map((user) => ({
        ...user,
        user: userMap.get(user.userId),
      })),
      day: contributors.day.map((user) => ({
        ...user,
        user: userMap.get(user.userId),
      })),
      teams: Object.fromEntries(
        Object.entries(contributors.teams).map(([team, users]) => [
          team,
          users.map((user) => ({ ...user, user: userMap.get(user.userId) })),
        ])
      ),
    };
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getUserRank({ event, userId }: EventInput & { userId: number }) {
  try {
    const { team } = await eventEngine.getUserData({ event, userId });
    const { teams } = await eventEngine.getTopContributors(event);
    if (!teams[team]) return null;

    const teamRankingIndex = teams[team].findIndex((x) => x.userId === userId);
    return teamRankingIndex >= 0 ? teamRankingIndex + 1 : null;
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}
