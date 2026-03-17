import type {
  GetWorkflowData,
  Options,
  SubmitWorkflowData,
  UpdateWorkflowRequest,
} from '@civitai/client';
import {
  addWorkflowTag,
  deleteWorkflow as clientDeleteWorkflow,
  getWorkflow as clientGetWorkflow,
  patchWorkflow,
  queryWorkflows as clientQueryWorkflows,
  removeWorkflowTag,
  submitWorkflow as clientSubmitWorkflow,
  updateWorkflow as clientUpdateWorkflow,
  handleError,
} from '@civitai/client';
import type * as z from 'zod';
import { isDev, isProd } from '~/env/other';
import type {
  PatchWorkflowParams,
  TagsPatchSchema,
  workflowIdSchema,
  workflowQuerySchema,
  workflowUpdateSchema,
} from '~/server/schema/orchestrator/workflows.schema';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwInsufficientFundsError,
  throwInternalServerError,
} from '~/server/utils/errorHandling';

export async function queryWorkflows({
  token,
  fromDate,
  toDate,
  ...query
}: z.output<typeof workflowQuerySchema> & { token: string; hideMatureContent: boolean }) {
  const client = createOrchestratorClient(token);

  const { data, error } = await clientQueryWorkflows({
    client,
    query: {
      ...query,
      tags: ['civitai', ...(query.tags ?? [])],
      fromDate: fromDate?.toISOString(),
      toDate: toDate?.toISOString(),
    },
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

export async function getWorkflow({
  token,
  path,
  query,
}: Options<GetWorkflowData> & { token: string }) {
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
}: Options<SubmitWorkflowData> & { token: string }) {
  const client = createOrchestratorClient(token);
  if (!body) throw throwBadRequestError();

  // const steps = body.steps;
  // if (steps.length > 0) {
  //   // At the moment, we mainly have 1 step, but in the future, we might wanna look at the minimum and maximum nsfw level.
  //   const maxNsfwLevel: NSFWLevel | undefined = steps.find((step) => !!step.metadata?.maxNsfwLevel)
  //     ?.metadata?.maxNsfwLevel as NSFWLevel;

  //   body.nsfwLevel = maxNsfwLevel ?? 'xxx';
  // }

  body.upgradeMode = 'manual';

  if (isDev) {
    console.log('------');
    console.log(JSON.stringify({ ...body, tags: ['civitai', ...(body.tags ?? [])] }));
    console.log('------');
  }

  const { data, error, response, ...res } = await clientSubmitWorkflow({
    client,
    body: { ...body, tags: ['civitai', ...(body.tags ?? [])] },
    query,
  });

  if (!data) {
    const { messages } = (typeof error !== 'string' ? error.errors ?? {} : {}) as {
      messages?: string[];
    };
    let message = messages?.length ? messages.join(',\n') : handleError(error);
    if (
      body.allowMatureContent === false &&
      message === 'Prompt requires mature content but workflow does not allow it' &&
      body.currencies?.includes('green')
    )
      message =
        'The prompt has been blocked due to mature content which is not supported by the current model';

    if (!isProd) {
      console.log('----Workflow Error----');
      console.log({ token });
      console.dir({ error }, { depth: null });
      console.dir({ res, data }, { depth: null });
      console.log('----Workflow Error Request Body----');
      console.dir(JSON.stringify(body));
      console.log('----Workflow End Error Request Body----');
    }
    switch (response.status) {
      case 400:
        throw throwBadRequestError(message);
      case 401:
        throw throwAuthorizationError(message);
      case 403:
        throw throwInsufficientFundsError(message);
      case 500:
        throw throwInternalServerError(message);
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
  token,
  ...body
}: UpdateWorkflowRequest & { token: string; workflowId: string }) {
  const client = createOrchestratorClient(token);

  await clientUpdateWorkflow({ client, path: { workflowId }, body });
  return await getWorkflow({ token, path: { workflowId } });
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
