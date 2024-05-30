import { resourceDataCache } from '~/server/redis/caches';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { GenerationStatus, generationStatusSchema } from '~/server/schema/generation.schema';
import {
  allInjectedIds,
  minorNegatives,
  minorPositives,
  safeNegatives,
} from '~/shared/constants/generation.constants';

export async function getGenerationStatus() {
  const status = generationStatusSchema.parse(
    JSON.parse((await redis.hGet(REDIS_KEYS.SYSTEM.FEATURES, REDIS_KEYS.GENERATION.STATUS)) ?? '{}')
  );

  return status as GenerationStatus;
}
export async function getResourceDataWithInjects(modelVersionIds: number[]) {
  const ids = [...modelVersionIds, ...allInjectedIds];
  const allResources = await resourceDataCache.fetch(ids);

  function getInjected(injected: Array<{ id: number; triggerWord: string }>) {
    return allResources
      .filter((x) => injected.some((y) => y.id === x.id))
      .map((resource) => ({
        ...resource,
        ...injected.find((x) => x.id === resource.id),
      }));
  }

  return {
    resources: allResources.filter((x) => !allInjectedIds.includes(x.id)),
    safeNegatives: getInjected(safeNegatives),
    minorNegatives: getInjected(minorNegatives),
    minorPositives: getInjected(minorPositives),
  };
}
