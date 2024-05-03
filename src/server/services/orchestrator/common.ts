import { CacheTTL } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { GenerationStatus, generationStatusSchema } from '~/server/schema/generation.schema';
import {
  GenerationResourceSelect,
  generationResourceSelect,
} from '~/server/selectors/generation.selector';
import { cachedArray } from '~/server/utils/cache-helpers';
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

export type ResourceData = AsyncReturnType<typeof getResourceData>[number];
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

export async function getResourceDataWithInjects(modelVersionIds: number[]) {
  const ids = [...modelVersionIds, ...allInjectedIds];
  const allResources = await getResourceData(ids);

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
