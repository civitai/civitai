import { PrismaClient } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { redis } from '~/server/redis/client';

export function createEvent<T>(definition: HolidayEventDefinition) {
  async function getCosmetic(name?: string) {
    const cachedCosmeticId = await redis.hGet('cosmeticIds', name ?? definition.cosmeticName);
    if (cachedCosmeticId) return Number(cachedCosmeticId);
    const cosmetic = await dbWrite.cosmetic.findFirst({
      where: { name: name ?? definition.cosmeticName },
    });
    if (!cosmetic) return;

    await redis.hSet('cosmeticIds', name ?? definition.cosmeticName, cosmetic.id.toString());
    return cosmetic.id;
  }

  async function getKey<T>(key: string, defaultValue = '{}') {
    const json = (await redis.hGet(definition.name, key)) ?? defaultValue;
    return JSON.parse(json) as T;
  }
  async function setKey(key: string, value: any) {
    await redis.hSet(definition.name, key, JSON.stringify(value));
  }
  async function clearKeys() {
    await redis.del(definition.name);
  }

  return {
    getCosmetic,
    getKey,
    setKey,
    clearKeys,
    ...definition,
  };
}

export type EngagementEvent = {
  userId: number;
  type: 'published';
  entityType: 'post' | 'model' | 'modelVersion' | 'article';
  entityId: number;
};

type ProcessingContext = EngagementEvent & {
  db: PrismaClient;
};

type HolidayEventDefinition = {
  name: string;
  startDate: Date;
  endDate: Date;
  cosmeticName: string;
  onEngagement?: (ctx: ProcessingContext) => Promise<void>;
};
