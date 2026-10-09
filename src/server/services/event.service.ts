import { getTRPCErrorFromUnknown } from '@trpc/server';
import { pack } from 'msgpackr';
import { CacheTTL } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import type { EventViewer } from '~/server/events/event-access';
import {
  cosmeticCache,
  profilePictureCache,
  refreshOwnedStickerCache,
  userBasicCache,
} from '~/server/redis/caches';
import { redis, REDIS_KEYS, REDIS_SUB_KEYS } from '~/server/redis/client';
import { hSetWithTTL } from '~/server/redis/atomic';
import type { EventInput, TeamScoreHistoryInput } from '~/server/schema/event.schema';
import type { CosmeticScoreKey } from '~/server/events/scoring/cosmetic-placement.service';
import {
  getCosmeticScores,
  getEventStandings as getScoredEventStandings,
  getUserCosmeticScores,
} from '~/server/events/scoring/cosmetic-placement.service';
import { getCosmeticDetail } from '~/server/services/cosmetic.service';
import { cosmeticStatus, getCosmeticsForUsers } from '~/server/services/user.service';

// Every event read is gated on what the viewer may see (event-access.ts); a closed event reads as an
// unknown one.
type Viewer = { viewer: EventViewer };

export function getViewerEventAccess({ event, viewer }: EventInput & Viewer) {
  return eventEngine.getAccess(event, viewer);
}

export async function getEventData({ event, viewer }: EventInput & Viewer) {
  try {
    return await eventEngine.getEventData(event, viewer);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getTeamScores({ event, viewer }: EventInput & Viewer) {
  try {
    const access = await eventEngine.assertReadable(event, viewer);
    return await eventEngine.getTeamScores(event, access);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getTeamScoreHistory({ viewer, ...input }: TeamScoreHistoryInput & Viewer) {
  try {
    const access = await eventEngine.assertReadable(input.event, viewer);
    return await eventEngine.getTeamScoreHistory(input, access);
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
export async function getEventCosmetic({
  event,
  user,
}: EventInput & { user: { id: number; isModerator?: boolean } }) {
  const userId = user.id;
  try {
    await eventEngine.assertReadable(event, user);
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
      // Atomic packed-write: single EVAL replaces racy Promise.all([hSet, hExpire]).
      await hSetWithTTL(redis, key, userId.toString(), pack(userStatus), CacheTTL.hour * 1000);
    }

    const { cosmeticId } = userStatus;
    const cosmetic = (await cosmeticCache.fetch(cosmeticId))[cosmeticId];
    if (!cosmetic) return noCosmetic;

    return { ...userStatus, cosmetic } as EventCosmetic;
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getEventPartners({ event, viewer }: EventInput & Viewer) {
  try {
    await eventEngine.assertReadable(event, viewer);
    return await eventEngine.getPartners(event);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function activateEventCosmetic({
  event,
  user,
}: EventInput & { user: { id: number; isModerator?: boolean } }) {
  const userId = user.id;
  try {
    if (eventEngine.isJoinEvent(event)) {
      const { cosmeticId, team, joined } = await eventEngine.join(event, user);
      const cosmetic = await getCosmeticDetail({ id: cosmeticId });
      if (joined) {
        await redis.hDel(
          `${REDIS_KEYS.EVENT.CACHE}:${event}:${REDIS_SUB_KEYS.EVENT.COSMETICS}`,
          userId.toString()
        );
        await eventEngine.queueAddRole({ event, team, userId });
      }
      return { cosmetic };
    }

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

    await refreshOwnedStickerCache([userId]);

    const cacheKey =
      `${REDIS_KEYS.EVENT.CACHE}:${event}:${REDIS_SUB_KEYS.EVENT.COSMETICS}` as const;

    // Update cache — atomic packed-write replaces racy Promise.all([hSet, hExpire]).
    await hSetWithTTL(
      redis,
      cacheKey,
      userId.toString(),
      pack({
        equipped: true,
        available: true,
        obtained: true,
        data,
        cosmeticId,
      }),
      CacheTTL.hour * 1000
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

export async function getEventRewards({ event, viewer }: EventInput & Viewer) {
  try {
    await eventEngine.assertReadable(event, viewer);
    return await eventEngine.getRewards(event);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getEventContributors({ event, viewer }: EventInput & Viewer) {
  try {
    await eventEngine.assertReadable(event, viewer);
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

export async function getUserRank({
  event,
  user,
}: EventInput & { user: { id: number; isModerator?: boolean } }) {
  const userId = user.id;
  try {
    await eventEngine.assertReadable(event, user);
    const { team } = await eventEngine.getUserData({ event, userId });
    const { teams } = await eventEngine.getTopContributors(event);
    if (!teams[team]) return null;

    const teamRankingIndex = teams[team].findIndex((x) => x.userId === userId);
    return teamRankingIndex >= 0 ? teamRankingIndex + 1 : null;
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getEventStandings({ event, viewer }: EventInput & Viewer) {
  try {
    const scored = await eventEngine.getReadableScoredEvent(event, viewer);
    const standings = await getScoredEventStandings(scored);
    const userIds = [
      ...new Set([
        ...standings.topCosmetics.map((x) => x.userId),
        ...Object.values(standings.topUsers).flatMap((x) => x.map((u) => u.userId)),
      ]),
    ];
    const users = await userBasicCache.fetch(userIds);
    return { ...standings, users };
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getMyEventCosmeticScores({
  event,
  user,
}: EventInput & { user: { id: number; isModerator?: boolean } }) {
  try {
    const scored = await eventEngine.getReadableScoredEvent(event, user);
    const scores = await getUserCosmeticScores(scored, user.id);
    const details = await cosmeticCache.fetch([...new Set(scores.map((x) => x.cosmeticId))]);
    const cosmetics = scores.map((x) => ({ ...x, name: details[x.cosmeticId]?.name ?? null }));
    const points = cosmetics.reduce((sum, x) => sum + x.points, 0);
    return { points, cosmetics };
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getEventCosmeticScores({
  event,
  cosmetics,
  viewer,
}: EventInput & Viewer & { cosmetics: CosmeticScoreKey[] }) {
  try {
    const scored = await eventEngine.getReadableScoredEvent(event, viewer);
    return await getCosmeticScores(scored, cosmetics);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}
