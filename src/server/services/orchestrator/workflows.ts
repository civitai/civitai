import {
  $OpenApiTs,
  queryWorkflows as clientQueryWorkflows,
  getWorkflow as clientGetWorkflow,
  submitWorkflow as clientSubmitWorkflow,
  updateWorkflow as clientUpdateWorkflow,
  deleteWorkflow as clientDeleteWorkflow,
} from '@civitai/client';
import { z } from 'zod';
import {
  workflowQuerySchema,
  workflowIdSchema,
  workflowUpdateSchema,
} from '~/server/schema/orchestrator/workflows.schema';
import { createOrchestratorClient } from '~/server/services/orchestrator/common';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwInsufficientFundsError,
} from '~/server/utils/errorHandling';

export async function queryWorkflows({
  token,
  ...query
}: z.output<typeof workflowQuerySchema> & { token: string }) {
  const client = createOrchestratorClient(token);

  const { data, error } = await clientQueryWorkflows({
    client,
    query: { ...query, tags: ['civitai', ...(query.tags ?? [])] },
  }).catch((error) => {
    throw error;
  });
  if (!data) throw error;
  const { next, items = [] } = data;

  return { nextCursor: next, items };
}

export async function getWorkflow({
  token,
  path,
  query,
}: $OpenApiTs['/v2/consumer/workflows/{workflowId}']['get']['req'] & { token: string }) {
  const client = createOrchestratorClient(token);
  const { data, error } = await clientGetWorkflow({ client, path, query });
  if (!data) throw error;

  return data;
}

export async function submitWorkflow({
  token,
  body,
  query,
}: $OpenApiTs['/v2/consumer/workflows']['post']['req'] & { token: string }) {
  const client = createOrchestratorClient(token);
  if (!body) throw throwBadRequestError();

  const { data, error } = await clientSubmitWorkflow({
    client,
    body: { ...body, tags: ['civitai', ...(body.tags ?? [])] },
    query,
  });
  if (!data) {
    // console.log('-------ERROR-------');
    // console.dir({ error }, { depth: null });
    // console.dir({ body, query }, { depth: null });
    // console.log('-------END ERROR-------');
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
  }

  return data;
}

export async function cancelWorkflow({
  workflowId,
  token,
}: z.infer<typeof workflowIdSchema> & { token: string }) {
  const client = createOrchestratorClient(token);

  await clientUpdateWorkflow({ client, path: { workflowId }, body: { status: 'canceled' } });
}

export async function deleteWorkflow({
  workflowId,
  token,
}: z.infer<typeof workflowIdSchema> & { token: string }) {
  const client = createOrchestratorClient(token);

  await clientDeleteWorkflow({ client, path: { workflowId } });
}

export async function deleteManyWorkflows({
  workflowIds,
  token,
}: {
  workflowIds: string[];
  token: string;
}) {
  const client = createOrchestratorClient(token);

  await Promise.all(
    workflowIds.map((workflowId) => clientDeleteWorkflow({ client, path: { workflowId } }))
  );
}

export async function updateWorkflow({
  workflowId,
  metadata,
  token,
}: z.infer<typeof workflowUpdateSchema> & { token: string }) {
  const client = createOrchestratorClient(token);

  await clientUpdateWorkflow({ client, path: { workflowId }, body: { metadata } });
}

export async function updateManyWorkflows({
  workflows,
  token,
}: {
  workflows: z.infer<typeof workflowUpdateSchema>[];
  token: string;
}) {
  const client = createOrchestratorClient(token);

  await Promise.all(
    workflows.map(({ workflowId, metadata }) =>
      clientUpdateWorkflow({ client, path: { workflowId }, body: { metadata } })
    )
  );
}
