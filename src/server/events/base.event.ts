import { PrismaClient } from '@prisma/client';
import Rand, { PRNG } from 'rand-seed';
import { dbWrite } from '~/server/db/client';
import { redis } from '~/server/redis/client';

export function createEvent<T>(name: string, definition: HolidayEventDefinition) {
  async function getCosmetic(name: string) {
    const cachedCosmeticId = await redis.hGet('cosmeticIds', name);
    if (cachedCosmeticId) return Number(cachedCosmeticId);
    const cosmetic = await dbWrite.cosmetic.findFirst({
      where: { name: name },
    });
    if (!cosmetic) return;

    await redis.hSet('cosmeticIds', name, cosmetic.id.toString());
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
    await redis.del(`event:${name}:cosmetic`);
  }
  function getUserTeam(userId: number) {
    const random = new Rand(name + userId.toString(), PRNG.sfc32);
    const number = random.next();
    const index = Math.floor(number * definition.teams.length);
    return definition.teams[index];
  }
  function getTeamCosmetic(team: string) {
    const name = `${definition.cosmeticName} - ${team}`;
    return getCosmetic(name);
  }
  function getUserCosmeticId(userId: number) {
    return getTeamCosmetic(getUserTeam(userId));
  }
  async function getRewards() {
    const eventName = definition.title;
    const rewards = await dbWrite.cosmetic.findMany({
      where: { name: { contains: eventName }, source: 'Claim' },
      select: { id: true, name: true, data: true, type: true },
    });

    return rewards;
  }

  return {
    getCosmetic,
    getKey,
    setKey,
    clearKeys,
    getTeamCosmetic,
    getUserTeam,
    getUserCosmeticId,
    getRewards,
    name,
    ...definition,
  };
}

export type EngagementEvent = {
  userId: number;
  type: 'published';
  entityType: 'post' | 'model' | 'modelVersion' | 'article';
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

type HolidayEventDefinition = {
  title: string;
  startDate: Date;
  endDate: Date;
  teams: string[];
  bankIndex: number;
  cosmeticName: string;
  onEngagement?: (ctx: ProcessingContext) => Promise<void>;
  onDailyReset?: (ctx: DailyResetContext) => Promise<void>;
};
