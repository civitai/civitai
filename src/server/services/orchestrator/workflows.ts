import { $OpenApiTs, ApiError, CivitaiClient } from '@civitai/client';
import { SessionUser } from 'next-auth';
import { z } from 'zod';
import { isDev } from '~/env/other';
import {
  workflowQuerySchema,
  workflowIdSchema,
} from '~/server/schema/orchestrator/workflows.schema';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwInsufficientFundsError,
} from '~/server/utils/errorHandling';

export async function queryWorkflows({
  user,
  ...params
}: z.output<typeof workflowQuerySchema> & { user: SessionUser }) {
  const client = new CivitaiClient({
    env: isDev ? 'dev' : 'prod',
    auth: 'ff2ddeabd724b029112668447a9388f7', // TODO - use user api token
  });

  const { next, items = [] } = await client.workflows.queryWorkflows(params);

  return { nextCursor: next, items };
}

export async function getWorkflow({
  user,
  ...params
}: $OpenApiTs['/v2/consumer/workflows/{workflowId}']['get']['req'] & { user: SessionUser }) {
  const client = new CivitaiClient({
    env: isDev ? 'dev' : 'prod',
    auth: 'ff2ddeabd724b029112668447a9388f7', // TODO - use user api token
  });

  return await client.workflows.getWorkflow(params);
}

export async function submitWorkflow({
  user,
  ...params
}: $OpenApiTs['/v2/consumer/workflows']['post']['req'] & { user: SessionUser }) {
  const client = new CivitaiClient({
    env: isDev ? 'dev' : 'prod',
    auth: 'ff2ddeabd724b029112668447a9388f7', // TODO - use user api token
  });

  return await client.workflows.submitWorkflow(params).catch((error) => {
    if (error instanceof ApiError) {
      console.log('-------ERROR-------');
      console.dir({ error }, { depth: null });
      switch (error.status) {
        case 400:
          throw throwBadRequestError(); // TODO - better error handling
        case 401:
          throw throwAuthorizationError();
        case 403:
          throw throwInsufficientFundsError();
        default:
          throw error;
      }
    } else throw error;
  });
}

export async function cancelWorkflow({
  workflowId,
  user,
}: z.infer<typeof workflowIdSchema> & { user: SessionUser }) {
  const client = new CivitaiClient({
    env: isDev ? 'dev' : 'prod',
    auth: 'ff2ddeabd724b029112668447a9388f7', // TODO - use user api token
  });

  return await client.workflows.updateWorkflow({ workflowId, requestBody: { status: 'canceled' } });
}

export async function deleteWorkflow({
  workflowId,
  user,
}: z.infer<typeof workflowIdSchema> & { user: SessionUser }) {
  const client = new CivitaiClient({
    env: isDev ? 'dev' : 'prod',
    auth: 'ff2ddeabd724b029112668447a9388f7', // TODO - use user api token
  });

  return await client.workflows.deleteWorkflow({ workflowId });
}
