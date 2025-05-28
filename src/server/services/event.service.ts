import { getTRPCErrorFromUnknown } from '@trpc/server';
import { CacheTTL } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import { cosmeticCache, profilePictureCache, userBasicCache } from '~/server/redis/caches';
import { redis, REDIS_KEYS, REDIS_SUB_KEYS } from '~/server/redis/client';
import type { EventInput, TeamScoreHistoryInput } from '~/server/schema/event.schema';
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
  cosmetic: Awaited<ReturnType<typeof cosmeticCache.fetch>>[number] | null;
};
const noCosmetic = {
  available: false,
  obtained: false,
  equipped: false,
  data: {},
  cosmetic: null,
} as EventCosmetic;
export async function getEventCosmetic({ event, userId }: EventInput & { userId: number }) {
  try {
    const key = `${REDIS_KEYS.EVENT.CACHE}:${event}:${REDIS_SUB_KEYS.EVENT.COSMETICS}` as const;
    // TODO optimize, let's cache this to avoid multiple queries
    let userStatus = await redis.packed.hGet<
      Awaited<ReturnType<typeof cosmeticStatus>> & { cosmeticId: number }
    >(key, userId.toString());
    if (!userStatus) {
      const { cosmeticId } = await eventEngine.getUserData({ event, userId });
      if (!cosmeticId) return noCosmetic;

      const status = await cosmeticStatus({ id: cosmeticId, userId });
      userStatus = { ...status, cosmeticId };
      await Promise.all([
        redis.packed.hSet(key, userId.toString(), userStatus),
        redis.hExpire(key, userId.toString(), CacheTTL.hour),
      ]);
    }

    const { cosmeticId } = userStatus;
    const cosmetic = (await cosmeticCache.fetch(cosmeticId))[cosmeticId];
    if (!cosmetic) return noCosmetic;

    return { ...userStatus, cosmetic } as EventCosmetic;
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
    const [{ data }] = (await dbWrite.$queryRaw<{ data: any }[]>`
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey", "obtainedAt")
      VALUES (${userId}, ${cosmeticId}, ${event}, NOW())
      ON CONFLICT ("userId", "cosmeticId", "claimKey") DO UPDATE SET "equippedAt" = NOW()
      RETURNING data;
    `) ?? [{ data: {} }];

    const cacheKey =
      `${REDIS_KEYS.EVENT.CACHE}:${event}:${REDIS_SUB_KEYS.EVENT.COSMETICS}` as const;

    // Update cache
    await Promise.all([
      redis.packed.hSet(cacheKey, userId.toString(), {
        equipped: true,
        available: true,
        obtained: true,
        data,
        cosmeticId,
      }),
      redis.hExpire(cacheKey, userId.toString(), CacheTTL.hour),
    ]);

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
