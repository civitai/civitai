import {
  addWorkflowTag,
  deleteWorkflow as clientDeleteWorkflow,
  getWorkflow as clientGetWorkflow,
  GetWorkflowData,
  patchWorkflow,
  queryWorkflows as clientQueryWorkflows,
  removeWorkflowTag,
  submitWorkflow as clientSubmitWorkflow,
  SubmitWorkflowData,
  updateWorkflow as clientUpdateWorkflow,
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
  throwInternalServerError,
} from '~/server/utils/errorHandling';

export async function queryWorkflows({
  token,
  ...query
}: z.output<typeof workflowQuerySchema> & { token: string }) {
  const client = createOrchestratorClient(token);

  const { data, error, request } = await clientQueryWorkflows({
    client,
    query: { ...query, tags: ['civitai', ...(query.tags ?? [])] },
  }).catch((error) => {
    throw error;
  });
  if (!data) {
    switch (error.status) {
      case 400:
        throw throwBadRequestError(error.detail);
      case 401:
        throw throwAuthorizationError(error.detail);
      case 403:
        throw throwInsufficientFundsError(error.detail);
      default:
        if (error.detail?.startsWith('<!DOCTYPE'))
          throw throwInternalServerError('Generation services down');
        throw error;
    }
  }
  const { next, items = [] } = data;

  return { nextCursor: next, items };
}

export async function getWorkflow({ token, path, query }: GetWorkflowData & { token: string }) {
  const client = createOrchestratorClient(token);
  const { data, error } = await clientGetWorkflow({ client, path, query });
  if (!data) {
    switch (error.status) {
      case 400:
        throw throwBadRequestError(error.detail);
      case 401:
        throw throwAuthorizationError(error.detail);
      case 403:
        throw throwInsufficientFundsError(error.detail);
      default:
        if (error.detail?.startsWith('<!DOCTYPE'))
          throw throwInternalServerError('Generation services down');
        throw error;
    }
  }

  return data;
}

export async function submitWorkflow({
  token,
  body,
  query,
}: SubmitWorkflowData & { token: string }) {
  const client = createOrchestratorClient(token);
  if (!body) throw throwBadRequestError();

  // const steps = body.steps;
  // if (steps.length > 0) {
  //   // At the moment, we mainly have 1 step, but in the future, we might wanna look at the minimum and maximum nsfw level.
  //   const maxNsfwLevel: NSFWLevel | undefined = steps.find((step) => !!step.metadata?.maxNsfwLevel)
  //     ?.metadata?.maxNsfwLevel as NSFWLevel;

  //   body.nsfwLevel = maxNsfwLevel ?? 'xxx';
  // }

  const { data, error } = await clientSubmitWorkflow({
    client,
    body: { ...body, tags: ['civitai', ...(body.tags ?? [])] },
    query,
  });

  if (!data) {
    const e = error as any;
    const message = e.errors?.messages ? e.errors.messages.join('\n') : e.detail;

    if (!isProd) {
      console.log('----Workflow Error----');
      console.log({ token });
      console.dir({ error }, { depth: null });
      console.log('----Workflow Error Request Body----');
      console.dir(JSON.stringify(body));
      console.log('----Workflow End Error Request Body----');
    }
    console.log({ message });
    switch (error.status) {
      case 400:
        throw throwBadRequestError(message);
      case 401:
        throw throwAuthorizationError(message);
      case 403:
        throw throwInsufficientFundsError(message);
      default:
        if (message?.startsWith('<!DOCTYPE'))
          throw throwInternalServerError('Generation services down');
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
