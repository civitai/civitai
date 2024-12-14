import { getTRPCErrorFromUnknown } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import { profilePictureCache, userBasicCache } from '~/server/redis/caches';
import { redis } from '~/server/redis/client';
import { EventInput, TeamScoreHistoryInput } from '~/server/schema/event.schema';
import { getCosmeticDetail } from '~/server/services/cosmetic.service';
import { cosmeticStatus, getCosmeticsForUsers } from '~/server/services/user.service';

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
    const cacheJson = await redis.packed.hGet<EventCosmetic>(
      `packed:event:${event}:cosmetic`,
      userId.toString()
    );
    if (cacheJson) return cacheJson;

    const { cosmeticId } = await eventEngine.getUserData({ event, userId });
    if (!cosmeticId)
      return { available: false, obtained: false, equipped: false, data: {}, cosmetic: null };

    // TODO.holiday optimization - We should probably store the cosmetic separately so we don't repeat it over and over in the cache
    const cosmetic = await getCosmeticDetail({ id: cosmeticId });
    const status = await cosmeticStatus({ id: cosmeticId, userId });
    // Get the userCosmetic record so we can display the data

    const result: EventCosmetic = { ...status, cosmetic };
    await redis.packed.hSet(`packed:event:${event}:cosmetic`, userId.toString(), result);

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
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey", "obtainedAt")
      VALUES (${userId}, ${cosmeticId}, ${event}, NOW())
      ON CONFLICT ("userId", "cosmeticId", "claimKey") DO UPDATE SET "equippedAt" = NOW()
    `;

    const { data } = (await dbWrite.userCosmetic.findUnique({
      where: { userId_cosmeticId_claimKey: { userId, cosmeticId, claimKey: 'claimed' } },
      select: { data: true },
    })) ?? { data: {} };

    // Update cache
    await redis.packed.hSet(`packed:event:${event}:cosmetic`, userId.toString(), {
      equipped: true,
      available: true,
      obtained: true,
      data,
      cosmetic,
    });

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
    const userIdSet = new Set<number>();
    for (const team of Object.values(contributors.teams)) {
      for (const user of team) userIdSet.add(user.userId);
    }
    for (const user of contributors.allTime) userIdSet.add(user.userId);
    for (const user of contributors.day) userIdSet.add(user.userId);

    const userIds = Array.from(userIdSet);
    const users = await userBasicCache.fetch(userIds);
    const profilePictures = await profilePictureCache.fetch(userIds);
    const userCosmetics = await getCosmeticsForUsers(userIds);

    const userMap = new Map(
      Object.values(users).map((user) => [
        user.id,
        {
          ...user,
          profilePicture: profilePictures[user.id],
          cosmetics: userCosmetics[user.id] ?? [],
        },
      ])
    );

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
