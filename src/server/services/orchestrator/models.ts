import { getResource, invalidateResource } from '@civitai/client';
import { z } from 'zod';
import { getModelByAirSchema } from '~/server/schema/orchestrator/models.schema';
import {
  createOrchestratorClient,
  getResourceDataWithAirs,
  internalOrchestratorClient,
} from '~/server/services/orchestrator/common';

export async function getModel({
  token,
  air,
}: z.output<typeof getModelByAirSchema> & { token: string }) {
  const client = createOrchestratorClient(token);

  return await getResource({ client, path: { air } });
}

export async function bustOrchestratorModelCache(versionIds: number[]) {
  const resources = await getResourceDataWithAirs(versionIds);
  if (!resources.length) return;

  await Promise.all(
    resources.map((resource) =>
      invalidateResource({
        client: internalOrchestratorClient,
        path: { air: resource.air },
      })
    )
  );
}
