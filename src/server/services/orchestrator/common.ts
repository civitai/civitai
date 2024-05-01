import { CacheTTL, generationConfig } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { GenerationStatus, generationStatusSchema } from '~/server/schema/generation.schema';
import {
  GenerationResourceSelect,
  generationResourceSelect,
} from '~/server/selectors/generation.selector';
import { cachedArray } from '~/server/utils/cache-helpers';

export async function getGenerationStatus() {
  const status = generationStatusSchema.parse(
    JSON.parse((await redis.hGet(REDIS_KEYS.SYSTEM.FEATURES, REDIS_KEYS.GENERATION.STATUS)) ?? '{}')
  );

  return status as GenerationStatus;
}

export async function getResourceData(modelVersionIds: number[]) {
  return await cachedArray<GenerationResourceSelect>({
    key: REDIS_KEYS.GENERATION.RESOURCE_DATA,
    ids: modelVersionIds,
    idKey: 'id',
    lookupFn: async (ids) => {
      const dbResults = await dbRead.modelVersion.findMany({
        where: { id: { in: ids as number[] } },
        select: generationResourceSelect,
      });

      const results = dbResults.reduce((acc, result) => {
        acc[result.id] = result;
        return acc;
      }, {} as Record<string, GenerationResourceSelect>);
      return results;
    },
    ttl: CacheTTL.hour,
  });
}
