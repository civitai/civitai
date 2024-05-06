import { CivitaiClient, TaintRequest } from '@civitai/client';
import { SessionUser } from 'next-auth';
import { z } from 'zod';
import { isDev } from '~/env/other';

export const taintJobSchema = z.object({
  id: z.string(),
  reason: z.string(),
  context: z.record(z.any()).optional(),
});

export async function taintJob({
  id,
  user,
  ...taint
}: z.output<typeof taintJobSchema> & { user: SessionUser }) {
  const client = new CivitaiClient({
    env: isDev ? 'dev' : 'prod',
    auth: 'ff2ddeabd724b029112668447a9388f7', // TODO - use user api token
  });

  await client.jobs.updateJob({ jobId: id, requestBody: { taint } });
}

export async function deleteJob({ id, user }: { id: string; user: SessionUser }) {
  const client = new CivitaiClient({
    env: isDev ? 'dev' : 'prod',
    auth: 'ff2ddeabd724b029112668447a9388f7', // TODO - use user api token
  });

  await client.jobs.deleteJob({ jobId: id }); // TODO - check if `requestId` can be removed from method params
}

export async function cancelJob({ id, user }: { id: string; user: SessionUser }) {
  const client = new CivitaiClient({
    env: isDev ? 'dev' : 'prod',
    auth: 'ff2ddeabd724b029112668447a9388f7', // TODO - use user api token
  });

  await client.jobs.updateJob({ jobId: id, requestBody: { status: 'Canceled' } });
}
