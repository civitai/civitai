import { getResource, invalidateResource } from '@civitai/client';
import { z } from 'zod';
import { getModelByAirSchema } from '~/server/schema/orchestrator/models.schema';
import { resourceDataCache } from '~/server/services/model-version.service';
import {
  createOrchestratorClient,
  internalOrchestratorClient,
} from '~/server/services/orchestrator/common';
import { stringifyAIR } from '~/utils/string-helpers';

export async function getModel({
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

  await Promise.all(
    resources.map(async (resource) => {
      const air = stringifyAIR({
        baseModel: resource.baseModel,
        type: resource.model.type,
        modelId: resource.model.id,
        id: resource.id,
      });

      await invalidateResource({
        client: internalOrchestratorClient,
        path: { air },
        query: userId ? { userId: [userId] } : undefined,
      });
    })
  );
}
