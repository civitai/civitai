import { CivitaiClient } from '@civitai/client';
import { resourceDataCache } from '~/server/redis/caches';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { GenerationStatus, generationStatusSchema } from '~/server/schema/generation.schema';
import {
  allInjectedIds,
  minorNegatives,
  minorPositives,
  safeNegatives,
} from '~/shared/constants/generation.constants';
import { stringifyAIR } from '~/utils/string-helpers';
import { env } from '~/env/server.mjs';

export class OrchestratorClient extends CivitaiClient {
  constructor(token: string) {
    // super({ env: 'dev', auth: token });
    super({ env: env.ORCHESTRATOR_MODE === 'dev' ? 'dev' : 'prod', auth: token });
  }
}

/** Used to perform orchestrator operations with the system user account */
export class InternalOrchestratorClient extends OrchestratorClient {
  constructor() {
    const token = env.ORCHESTRATOR_API_TOKEN;
    super(token);
  }
}

export async function getGenerationStatus() {
  const status = generationStatusSchema.parse(
    JSON.parse((await redis.hGet(REDIS_KEYS.SYSTEM.FEATURES, REDIS_KEYS.GENERATION.STATUS)) ?? '{}')
  );

  return status as GenerationStatus;
}

export type AirResourceData = AsyncReturnType<typeof getResourceDataWithAirs>[number];
export async function getResourceDataWithAirs(versionIds: number[]) {
  const resources = await resourceDataCache.fetch(versionIds);
  return resources.map((resource) => ({
    ...resource,
    air: stringifyAIR({
      baseModel: resource.baseModel,
      type: resource.model.type,
      source: 'civitai',
      modelId: resource.model.id,
      id: resource.id,
    }),
  }));
}

export async function getResourceDataWithInjects(modelVersionIds: number[]) {
  const ids = [...modelVersionIds, ...allInjectedIds];
  const allResources = await getResourceDataWithAirs(ids);

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
