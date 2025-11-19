import { getResource, invalidateResource } from '@civitai/client';
import { chunk } from 'lodash-es';
import type * as z from 'zod';
import { getCurrentLSN } from '~/server/db/db-helpers';
import type { getModelByAirSchema } from '~/server/schema/orchestrator/models.schema';
import { resourceDataCache } from '~/server/redis/resource-data.redis';
import {
  createOrchestratorClient,
  internalOrchestratorClient,
} from '~/server/services/orchestrator/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { stringifyAIR } from '~/shared/utils/air';

export async function getModelClient({
  token,
  air,
}: z.output<typeof getModelByAirSchema> & { token: string }) {
  const client = createOrchestratorClient(token);
  return await getResource({ client, path: { air } });
}

export async function bustOrchestratorModelCache(versionIds: number | number[], userId?: number) {
  if (!Array.isArray(versionIds)) versionIds = [versionIds];
  const resources = await resourceDataCache.fetch(versionIds);
  if (!resources.length) return;

  const currentLSN = await getCurrentLSN();
  const queryData = { etag: currentLSN };

  const tasks = chunk(resources, 100).map((chunk) => async () => {
    await Promise.all(
      chunk.map(async (resource) => {
        const air = stringifyAIR({
          baseModel: resource.baseModel,
          type: resource.model.type,
          modelId: resource.model.id,
          id: resource.id,
        });

        await invalidateResource({
          client: internalOrchestratorClient,
          path: { air },
          query: userId ? { ...queryData, userId: [userId] } : queryData,
        });
      })
    );
  });

  await limitConcurrency(tasks, 3);
}
