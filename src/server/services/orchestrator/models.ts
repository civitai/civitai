import { CivitaiClient } from '@civitai/client';
import { SessionUser } from 'next-auth';
import { z } from 'zod';
import { isDev } from '~/env/other';
import { getModelByAirSchema } from '~/server/schema/orchestrator/models.schema';

export async function getModel({
  user,
  ...params
}: z.output<typeof getModelByAirSchema> & { user: SessionUser }) {
  const client = new CivitaiClient({
    env: isDev ? 'dev' : 'prod',
    auth: 'ff2ddeabd724b029112668447a9388f7', // TODO - use user api token
  });

  return await client.models.getModel(params);
}

export async function deleteModel({
  user,
  ...params
}: z.output<typeof getModelByAirSchema> & { user: SessionUser }) {
  const client = new CivitaiClient({
    env: isDev ? 'dev' : 'prod',
    auth: 'ff2ddeabd724b029112668447a9388f7', // TODO - use user api token
  });

  return await client.models.deleteModel(params);
}
