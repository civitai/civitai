import {
  $OpenApiTs,
  addWorkflowTag,
  deleteWorkflow as clientDeleteWorkflow,
  getWorkflow as clientGetWorkflow,
  queryWorkflows as clientQueryWorkflows,
  submitWorkflow as clientSubmitWorkflow,
  updateWorkflow as clientUpdateWorkflow,
  patchWorkflow,
  removeWorkflowTag,
} from '@civitai/client';
import { z } from 'zod';
import { isProd } from '~/env/other';
import {
  PatchWorkflowParams,
  TagsPatchSchema,
  workflowIdSchema,
  workflowQuerySchema,
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
  if (!data) throw (error as any).errors?.messages?.join('\n');
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
  if (!data) throw (error as any).errors?.messages?.join('\n');

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
    const message = (error as any).errors?.messages?.join('\n');
    if (!isProd) {
      console.log('----Error Request Body----');
      console.dir(JSON.stringify(body));
      console.log('----End Error Request Body----');
    }
    switch (error.status) {
      case 400:
        throw throwBadRequestError(message);
      case 401:
        throw throwAuthorizationError(message);
      case 403:
        throw throwInsufficientFundsError(message);
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

export async function patchWorkflows({
  input,
  token,
}: {
  input: PatchWorkflowParams[];
  token: string;
}) {
  const client = createOrchestratorClient(token);
  await Promise.all(
    input.map(async ({ workflowId, patches }) => {
      await patchWorkflow({ client, body: patches, path: { workflowId } });
    })
  );
}

export async function patchWorkflowTags({
  input,
  token,
}: {
  input: TagsPatchSchema[];
  token: string;
}) {
  const client = createOrchestratorClient(token);
  await Promise.all(
    input.map(async ({ workflowId, tag, op }) => {
      if (op === 'add') await addWorkflowTag({ client, body: tag, path: { workflowId } });
      if (op === 'remove') await removeWorkflowTag({ client, path: { workflowId, tag } });
    })
  );
}
