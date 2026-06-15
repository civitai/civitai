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
  throwNotFoundError,
  throwRateLimitError,
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
      case 429:
        throw throwRateLimitError(error.detail);
      case 404:
        // Preserve not-found semantics on the read paths (a deleted/not-owned
        // workflowId) rather than flattening to BAD_REQUEST below.
        throw throwNotFoundError(error.detail);
      default:
        if (error.detail?.startsWith('<!DOCTYPE'))
          throw throwInternalServerError('Generation services down');
        // An unhandled 4xx is a client/validation fault (e.g. a 404 on a deleted or
        // not-owned workflow) — surface as 4xx, not a re-thrown raw error that tRPC
        // maps to 500. Genuine 5xx / status-less failures stay a server error.
        if (typeof error.status === 'number' && error.status >= 400 && error.status < 500)
          throw throwBadRequestError(error.detail);
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
      case 429:
        throw throwRateLimitError(error.detail);
      case 404:
        // Preserve not-found semantics on the read paths (a deleted/not-owned
        // workflowId) rather than flattening to BAD_REQUEST below.
        throw throwNotFoundError(error.detail);
      default:
        if (error.detail?.startsWith('<!DOCTYPE'))
          throw throwInternalServerError('Generation services down');
        // An unhandled 4xx is a client/validation fault (e.g. a 404 on a deleted or
        // not-owned workflow) — surface as 4xx, not a re-thrown raw error that tRPC
        // maps to 500. Genuine 5xx / status-less failures stay a server error.
        if (typeof error.status === 'number' && error.status >= 400 && error.status < 500)
          throw throwBadRequestError(error.detail);
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

  const result = await submitWorkflowWithRetry({
    client,
    body: { ...body, tags: ['civitai', ...(body.tags ?? [])] },
    query,
  });

  // Narrow on `result.data` (not a destructured copy) so this always-throwing
  // guard both exposes `error`/`response` on the failure member here AND narrows
  // `result.data` to defined for the `return` below.
  if (!result.data) {
    const { error, response } = result;
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
      console.dir({ result }, { depth: null });
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
      case 429:
        // Preserve rate-limit semantics: TOO_MANY_REQUESTS (not a flattened
        // BAD_REQUEST), so the client can back off AND the tRPC onError Axiom-skip
        // for TOO_MANY_REQUESTS keeps a 429 storm off the event loop.
        throw throwRateLimitError(message);
      case 500:
        throw throwInternalServerError(message);
      default:
        if (message?.startsWith('<!DOCTYPE'))
          throw throwInternalServerError('Generation services down');
        // An unhandled 4xx from the orchestrator is a client/validation fault
        // (e.g. "<resource> is not enabled for generation. Please contact …"),
        // not a server error. Surface it as a 4xx instead of re-throwing a raw
        // error that tRPC maps to INTERNAL_SERVER_ERROR (500) — that misclassified
        // generate/whatIf validation rejections as the app's own 500s. Genuine
        // upstream 5xx / status-less failures still fall through to a server error.
        if (typeof response.status === 'number' && response.status >= 400 && response.status < 500)
          throw throwBadRequestError(message);
        throw error;
    }
  }

  return result.data;
}

type SubmitOptions = Options<SubmitWorkflowData, false>;
type ClientSubmitResult = Awaited<ReturnType<typeof clientSubmitWorkflow>>;

export type SubmitWorkflowRetryOptions = {
  /** Max total submit attempts (initial + retries). Default 3. */
  maxAttempts?: number;
  /** Base backoff in ms; delay before retry N = baseDelayMs * 3 ** (N - 1). Default 500. */
  baseDelayMs?: number;
  /** Invoked right before each backoff sleep — useful for logging/metrics. */
  onRetry?: (info: { attempt: number; status?: number; delayMs: number }) => void;
};

/**
 * Thin wrapper around the `@civitai/client` `submitWorkflow` that re-submits on
 * transient infra failures (5xx responses, or a network error / no response) with
 * bounded exponential backoff. 4xx responses are returned immediately — client
 * errors won't recover. Returns the raw client result of the final attempt plus an
 * `attempts` count; callers keep their own error handling/logging.
 *
 * It does NOT add an idempotency key. If the same workflow must not be duplicated
 * when a 500 actually created it server-side, the CALLER must set `body.externalId`
 * (the orchestrator dedupes on `(userId, externalId)`); the same body — and thus
 * the same key — is reused across every retry here.
 */
export async function submitWorkflowWithRetry(
  options: SubmitOptions,
  { maxAttempts = 3, baseDelayMs = 500, onRetry }: SubmitWorkflowRetryOptions = {}
): Promise<ClientSubmitResult & { attempts: number }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result: ClientSubmitResult | undefined;
    try {
      result = await clientSubmitWorkflow(options);
    } catch (e) {
      // Network failure / no response. Out of retries → surface it like a direct call would.
      lastError = e;
      if (attempt >= maxAttempts) throw e;
      await submitWorkflowBackoff({ attempt, status: undefined, baseDelayMs, onRetry });
      continue;
    }

    const status = result.response?.status;
    const retryable = !result.data && (status == null || status >= 500);
    if (!retryable || attempt >= maxAttempts) {
      return Object.assign(result, { attempts: attempt });
    }

    await submitWorkflowBackoff({ attempt, status, baseDelayMs, onRetry });
  }

  // Only reachable if maxAttempts < 1 or every attempt threw without re-throwing above.
  throw lastError ?? new Error('submitWorkflowWithRetry: no attempts were made');
}

async function submitWorkflowBackoff({
  attempt,
  status,
  baseDelayMs,
  onRetry,
}: {
  attempt: number;
  status?: number;
  baseDelayMs: number;
  onRetry?: SubmitWorkflowRetryOptions['onRetry'];
}) {
  const delayMs = baseDelayMs * 3 ** (attempt - 1);
  onRetry?.({ attempt, status, delayMs });
  await new Promise((resolve) => setTimeout(resolve, delayMs));
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
