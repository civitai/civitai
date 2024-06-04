import { z } from 'zod';
import { getModelByAirSchema } from '~/server/schema/orchestrator/models.schema';
import { OrchestratorClient } from '~/server/services/orchestrator/common';

export async function getModel({
  token,
  ...params
}: z.output<typeof getModelByAirSchema> & { token: string }) {
  const client = new OrchestratorClient(token);

  return await client.models.getModel(params);
}

export async function deleteModel({
  token,
  ...params
}: z.output<typeof getModelByAirSchema> & { token: string }) {
  const client = new OrchestratorClient(token);

  return await client.models.deleteModel(params);
}
