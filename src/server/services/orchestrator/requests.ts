import { $OpenApiTs, ApiError, CivitaiClient } from '@civitai/client';
import { SessionUser } from 'next-auth';
import { z } from 'zod';
import { isDev } from '~/env/other';
import { throwBadRequestError, throwInsufficientFundsError } from '~/server/utils/errorHandling';

export const requestByIdSchema = z.object({
  id: z.string(),
});

export const getRequestsSchema = z.object({
  take: z.number().default(10),
  cursor: z.string().optional(),
  jobType: z.string().array().optional(),
});

export async function createRequest({
  data,
  user,
}: {
  data: $OpenApiTs['/v2/consumer/requests']['post']['req'];
  user: SessionUser;
}) {
  const client = new CivitaiClient({
    env: isDev ? 'dev' : 'prod',
    auth: 'ff2ddeabd724b029112668447a9388f7', // TODO - use user api token
  });

  return await client.requests.submitRequest(data).catch((error) => {
    // handle response errors
    if (error instanceof ApiError) {
      console.log('-------ERROR-------');
      console.dir({ error }, { depth: null });
      switch (error.status) {
        case 400:
          throw throwBadRequestError(); // TODO - better error handling
        case 403:
          throw throwInsufficientFundsError();
      }
    }
  });
}

export async function getRequests({
  user,
  take,
  cursor,
  jobType,
}: z.output<typeof getRequestsSchema> & { user: SessionUser }) {
  const client = new CivitaiClient({
    env: isDev ? 'dev' : 'prod',
    auth: 'ff2ddeabd724b029112668447a9388f7', // TODO - use user api token
  });

  const { next, items } = await client.requests.queryRequests({
    jobType,
    cursor,
    take,
    include: 'Details',
  });

  return {
    nextCursor: next,
    items: items ?? [],
  };
}

export async function deleteRequest({ id, user }: { id: string; user: SessionUser }) {
  const client = new CivitaiClient({
    env: isDev ? 'dev' : 'prod',
    auth: 'ff2ddeabd724b029112668447a9388f7', // TODO - use user api token
  });

  await client.requests.deleteRequest({ requestId: id });
}

export async function cancelRequest({ id, user }: { id: string; user: SessionUser }) {
  const client = new CivitaiClient({
    env: isDev ? 'dev' : 'prod',
    auth: 'ff2ddeabd724b029112668447a9388f7', // TODO - use user api token
  });

  await client.requests.updateRequest({ requestId: id, requestBody: { status: 'Canceled' } });
}
