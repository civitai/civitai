import { env } from '~/env/server.mjs';
import { z } from 'zod';
import { getModelByAirSchema } from '~/server/schema/orchestrator/models.schema';
import { OrchestratorClient, getResourceDataWithAirs } from '~/server/services/orchestrator/common';

export async function getModel({
  token,
  ...params
}: z.output<typeof getModelByAirSchema> & { token: string }) {
  const client = new OrchestratorClient(token);

  return await client.models.getModel(params);
}

export async function bustOrchestratorModelCache(versionIds: number[]) {
  const resources = await getResourceDataWithAirs(versionIds);
  if (!resources.length) return;
  const token = env.ORCHESTRATOR_API_TOKEN ?? '';
  const client = new OrchestratorClient(token);

  await Promise.all(resources.map((resource) => client.models.deleteModel({ air: resource.air })));
}
