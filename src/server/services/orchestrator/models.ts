import { CivitaiClient } from '@civitai/client';
import { z } from 'zod';
import { isDev } from '~/env/other';
import { getModelByAirSchema } from '~/server/schema/orchestrator/models.schema';

export async function getModel({
  token,
  ...params
}: z.output<typeof getModelByAirSchema> & { token: string }) {
  const client = new CivitaiClient({
    env: isDev ? 'dev' : 'prod',
    auth: token,
  });

  return await client.models.getModel(params);
}

export async function deleteModel({
  token,
  ...params
}: z.output<typeof getModelByAirSchema> & { token: string }) {
  const client = new CivitaiClient({
    env: isDev ? 'dev' : 'prod',
    auth: token,
  });

  return await client.models.deleteModel(params);
}
