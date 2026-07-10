import type { PrismaClient } from '@prisma/client';
import Rand, { PRNG } from 'rand-seed';
import { dbWrite } from '~/server/db/client';
import { discord } from '~/server/integrations/discord';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import {
  redis,
  REDIS_KEYS,
  REDIS_SUB_KEYS,
  REDIS_SYS_KEYS,
  sysRedis,
  withSysReadDeadline,
} from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';

// Disable pod memory keeping for now... We might not need it.
// const manualAssignments: Record<string, Record<string, string>> = {};
async function getManualAssignments(event: string) {
  // if (manualAssignments[event]) return manualAssignments[event];
  // Fail open: called via getUserTeam → getUserCosmeticId on every
  // user-cosmetic resolution during active events. A sysRedis outage
  // shouldn't 500 every cosmetic lookup — degrade to "no manual
  // assignments" for the outage window.
  try {
    // Wall-clock deadline: this read is on the per-request cosmetic-resolution
    // path during active events; the try/catch only covers a fast DOWN, so a
    // silent half-open would park it ~11min.
    const assignments = await withSysReadDeadline(
      sysRedis.hGetAll(
        `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.MANUAL_ASSIGNMENTS}`
      )
    );
    // manualAssignments[event] = assignments;
    return assignments;
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'getManualAssignments', err, { event });
    return {} as Record<string, string>;
  }
}
export async function addManualAssignments(event: string, team: string, users: string[]) {
  const userIds = await dbWrite.user.findMany({
    where: { username: { in: users } },
    select: { id: true },
  });

  for (const { id } of userIds) {
    await sysRedis.hSet(
      `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.MANUAL_ASSIGNMENTS}`,
      id.toString(),
      team
    );
  }
}

export function createEvent<T>(name: RedisKeyTemplateCache, definition: HolidayEventDefinition) {
  async function getCosmetic(name: string) {
    const cachedCosmeticId = await redis.hGet(REDIS_KEYS.COSMETICS.IDS, name);
    if (cachedCosmeticId) return Number(cachedCosmeticId);
    const cosmetic = await dbWrite.cosmetic.findFirst({
      where: { name: name },
    });
    if (!cosmetic) return;

    await redis.hSet(REDIS_KEYS.COSMETICS.IDS, name, cosmetic.id.toString());
    return cosmetic.id;
  }

  async function getKey<T>(key: string, defaultValue = '{}') {
    const json = (await redis.hGet(name, key)) ?? defaultValue;
    return JSON.parse(json) as T;
  }
  async function setKey(key: string, value: any) {
    await redis.hSet(name, key, JSON.stringify(value));
  }
  async function clearKeys() {
    await redis.del(name);
    await redis.del(`${REDIS_KEYS.EVENT.CACHE}:${name}:${REDIS_SUB_KEYS.EVENT.COSMETICS}`);
  }
  async function getUserTeam(userId: number) {
    const manualAssignment = await getManualAssignments(name);
    if (manualAssignment[userId.toString()]) return manualAssignment[userId.toString()];
    const random = new Rand(name + userId.toString(), PRNG.sfc32);
    const number = random.next();
    const index = Math.floor(number * definition.teams.length);
    return definition.teams[index];
  }
  function getTeamCosmetic(team: string) {
    const name = `${definition.cosmeticName} - ${team}`;
    return getCosmetic(name);
  }
  async function getUserCosmeticId(userId: number) {
    return getTeamCosmetic(await getUserTeam(userId));
  }
  async function clearUserCosmeticCache(userId: number) {
    await redis.hDel(
      `${REDIS_KEYS.EVENT.CACHE}:${name}:${REDIS_SUB_KEYS.EVENT.COSMETICS}`,
      userId.toString()
    );
  }
  async function getRewards() {
    const rewards = await dbWrite.cosmetic.findMany({
      where: { name: { startsWith: definition.badgePrefix }, source: 'Claim', type: 'Badge' },
      select: { id: true, name: true, data: true, description: true },
      orderBy: { id: 'asc' },
    });

    return rewards.map(({ name, ...reward }) => ({
      ...reward,
      name: name.replace(definition.badgePrefix, '').replace(':', '').trim(),
    }));

    return rewards;
  }
  async function getDiscordRoles() {
    const cacheKey =
      `${REDIS_SYS_KEYS.EVENT}:${name}:${REDIS_SUB_KEYS.EVENT.DISCORD_ROLES}` as const;
    // Read fail-open: if sysRedis is unreachable we early-return {}
    // immediately and SKIP the Discord API call. Net result during an
    // outage is "no discord roles for this event" — caller treats the
    // missing map as no-op.
    let roleCache: Record<string, string>;
    try {
      // Wall-clock deadline so a silent half-open can't park this awaited read
      // ~11min (the try/catch only covers a fast DOWN).
      roleCache = await withSysReadDeadline(sysRedis.hGetAll(cacheKey));
    } catch (err) {
      logSysRedisFailOpen('read-degraded', 'getDiscordRoles read', err, { event: name });
      return {} as Record<string, string>;
    }
    if (Object.keys(roleCache).length > 0) return roleCache;

    // Cache is empty, so we need to populate it
    const discordRoles = await discord.getAllRoles();
    for (const team of definition.teams) {
      const role = discordRoles.find((r) => r.name.includes(`(${team})`));
      if (!role) continue;
      roleCache[team] = role.id;
    }
    // Writeback fail-open (only reached when the read succeeded above):
    // we already have the freshly-resolved roles in memory, so a cache-
    // populate failure just means the next call will re-query Discord
    // instead of getting a sysRedis cache hit. Caller gets the same
    // roleCache return value regardless.
    try {
      await sysRedis.hSet(cacheKey, roleCache);
    } catch (err) {
      logSysRedisFailOpen('write-degraded', 'getDiscordRoles writeback', err, { event: name });
    }

    return roleCache;
  }

  return {
    getCosmetic,
    getKey,
    setKey,
    clearKeys,
    clearUserCosmeticCache,
    getTeamCosmetic,
    getUserTeam,
    getUserCosmeticId,
    getRewards,
    getDiscordRoles,
    name,
    ...definition,
  };
}

export type EngagementEvent = {
  userId: number;
  type: 'published' | 'entered';
  entityType: 'post' | 'model' | 'modelVersion' | 'article' | 'challenge';
  entityId: number;
};

export type TeamScore = {
  team: string;
  score: number;
  rank: number;
};

type ProcessingContext = EngagementEvent & {
  db: PrismaClient;
};

type DailyResetContext = {
  scores: TeamScore[];
  db: PrismaClient;
};

type CleanupContext = DailyResetContext & {
  winner: string;
  winnerCosmeticId?: number;
};

export type DonationCosmeticData = {
  donated?: number;
  purchased?: number;
};

export type BuzzEventContext = {
  userId: number;
  amount: number;
  userCosmeticData: DonationCosmeticData;
  db: PrismaClient;
};

type HolidayEventDefinition = {
  title: string;
  startDate: Date;
  endDate: Date;
  teams: string[];
  bankIndex: number;
  cosmeticName: string;
  badgePrefix: string;
  coverImage?: string;
  coverImageCollection?: string;
  onCleanup?: (ctx: CleanupContext) => Promise<void>;
  onEngagement?: (ctx: ProcessingContext) => Promise<void>;
  onPurchase?: (ctx: BuzzEventContext) => Promise<void>;
  onDonate?: (ctx: BuzzEventContext) => Promise<void>;
  onDailyReset?: (ctx: DailyResetContext) => Promise<void>;
};
