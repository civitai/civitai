import { $OpenApiTs, ApiError } from '@civitai/client';
import { z } from 'zod';
import {
  workflowQuerySchema,
  workflowIdSchema,
  workflowUpdateSchema,
} from '~/server/schema/orchestrator/workflows.schema';
import { OrchestratorClient } from '~/server/services/orchestrator/common';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwInsufficientFundsError,
} from '~/server/utils/errorHandling';

export async function queryWorkflows({
  token,
  ...params
}: z.output<typeof workflowQuerySchema> & { token: string }) {
  const client = new OrchestratorClient(token);

  const { next, items = [] } = await client.workflows.queryWorkflows(params);

  // console.dir(items, { depth: null });

  return { nextCursor: next, items };
}

export async function getWorkflow({
  token,
  ...params
}: $OpenApiTs['/v2/consumer/workflows/{workflowId}']['get']['req'] & { token: string }) {
  const client = new OrchestratorClient(token);

  return await client.workflows.getWorkflow(params);
}

export async function submitWorkflow({
  token,
  ...params
}: $OpenApiTs['/v2/consumer/workflows']['post']['req'] & { token: string }) {
  const client = new OrchestratorClient(token);
  // console.log({ token });
  // console.log(JSON.stringify(params));

  return await client.workflows.submitWorkflow(params).catch((error) => {
    if (error instanceof ApiError) {
      console.log('-------ERROR-------');
      console.dir({ error }, { depth: null });
      console.log('-------END ERROR-------');
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
  token,
}: z.infer<typeof workflowIdSchema> & { token: string }) {
  const client = new OrchestratorClient(token);

  await client.workflows.updateWorkflow({ workflowId, requestBody: { status: 'canceled' } });
}

export async function deleteWorkflow({
  workflowId,
  token,
}: z.infer<typeof workflowIdSchema> & { token: string }) {
  const client = new OrchestratorClient(token);

  await client.workflows.deleteWorkflow({ workflowId });
}

export async function deleteManyWorkflows({
  workflowIds,
  token,
}: {
  workflowIds: string[];
  token: string;
}) {
  const client = new OrchestratorClient(token);

  await Promise.all(
    workflowIds.map((workflowId) => client.workflows.deleteWorkflow({ workflowId }))
  );
}

export async function updateWorkflow({
  workflowId,
  metadata,
  token,
}: z.infer<typeof workflowUpdateSchema> & { token: string }) {
  const client = new OrchestratorClient(token);

  await client.workflows.updateWorkflow({ workflowId, requestBody: { metadata } });
}

export async function updateManyWorkflows({
  workflows,
  token,
}: {
  workflows: z.infer<typeof workflowUpdateSchema>[];
  token: string;
}) {
  const client = new OrchestratorClient(token);

  await Promise.all(
    workflows.map(({ workflowId, metadata }) =>
      client.workflows.updateWorkflow({ workflowId, requestBody: { metadata } })
    )
  );
}
