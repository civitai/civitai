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
  isUpstreamNetworkError,
  isUpstreamServerOrNetworkError,
  throwAuthorizationError,
  throwBadRequestError,
  throwInsufficientFundsError,
  throwInternalServerError,
  throwNotFoundError,
  throwRateLimitError,
  throwServiceUnavailableError,
} from '~/server/utils/errorHandling';

// Stable, user-facing copy for a transient orchestrator outage (HTTP 503). Shared
// by every read path that funnels through this module (getWorkflow → statusUpdate;
// queryWorkflows → queryGeneratedImages) so a brief upstream blip becomes one
// retry-able message instead of a wave of raw 500s with an empty body.
const ORCHESTRATOR_UNAVAILABLE_MESSAGE =
  'Generation services are temporarily unavailable. Please try again.';

// Backstop deadline for the orchestrator workflow READ (queryWorkflows). A read is
// safe to bound — the polling client simply re-fetches — so this caps a runaway
// query that would otherwise hang unbounded and pin a request. Sized well above the
// observed latency tail (max ~17.7s on the queryGeneratedImages feed) so it 503s
// essentially nothing today and only fires on a true runaway. A fired
// AbortSignal.timeout() throws a `TimeoutError`, which the existing
// `isUpstreamNetworkError` catch below classifies → retry-able 503 (no new handling
// needed). Bounds ALL queryWorkflows callers (queryGeneratedImages feed,
// queryWorkflowsByTags, queue-status, admin) — every one a request-scoped read.
const ORCHESTRATOR_QUERY_TIMEOUT_MS = 20_000;

export async function queryWorkflows({
  token,
  fromDate,
  toDate,
  ...query
}: z.output<typeof workflowQuerySchema> & { token: string; hideMatureContent: boolean }) {
  const client = createOrchestratorClient(token);

  const { data, error } = await clientQueryWorkflows({
    client,
    // Read backstop: abort a runaway orchestrator query (see constant above). The
    // resulting TimeoutError is caught below and mapped to a retry-able 503.
    signal: AbortSignal.timeout(ORCHESTRATOR_QUERY_TIMEOUT_MS),
    query: {
      ...query,
      tags: ['civitai', ...(query.tags ?? [])],
      fromDate: fromDate?.toISOString(),
      toDate: toDate?.toISOString(),
    },
  }).catch((thrown) => {
    // A rejected client call has no HTTP status. A recognized NETWORK failure
    // (fetch failed / ECONNREFUSED / timeout) is a transient upstream outage →
    // retry-able 503, not an app 500. An unrecognized throw (a real bug in our
    // code) is left to bubble as a 500.
    if (isUpstreamNetworkError(thrown))
      throw throwServiceUnavailableError(ORCHESTRATOR_UNAVAILABLE_MESSAGE, thrown);
    throw thrown;
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
        // maps to 500.
        if (typeof error.status === 'number' && error.status >= 400 && error.status < 500)
          throw throwBadRequestError(error.detail);
        // A genuine upstream 5xx (or status-less network fault) is a transient
        // dependency outage — surface as a retry-able 503 so the polling client
        // backs off, instead of a raw 500 with an empty message that counts
        // against our 500 SLO. Unexpected/unclassified errors still fall through
        // to a raw re-throw (→ 500) so real bugs stay visible.
        if (isUpstreamServerOrNetworkError({ clientError: error, thrown: error }))
          throw throwServiceUnavailableError(ORCHESTRATOR_UNAVAILABLE_MESSAGE, error);
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
  const { data, error } = await clientGetWorkflow({ client, path, query }).catch((thrown) => {
    // The generated client REJECTS (no `{ data, error }` result) when the fetch
    // itself fails — e.g. orchestrator unreachable. The statusUpdate poll fires
    // continuously, so a brief blip here otherwise becomes a wave of raw 500s
    // (TypeError: fetch failed). A recognized network failure → retry-able 503;
    // an unrecognized throw (a real bug) bubbles as a 500.
    if (isUpstreamNetworkError(thrown))
      throw throwServiceUnavailableError(ORCHESTRATOR_UNAVAILABLE_MESSAGE, thrown);
    throw thrown;
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
        // maps to 500.
        if (typeof error.status === 'number' && error.status >= 400 && error.status < 500)
          throw throwBadRequestError(error.detail);
        // A genuine upstream 5xx (or status-less network fault) is a transient
        // dependency outage — surface as a retry-able 503 (SERVICE_UNAVAILABLE)
        // with a stable message + the original error preserved as `cause`,
        // instead of re-throwing the raw client error (empty message → tRPC
        // INTERNAL_SERVER_ERROR 500 against our 500 SLO). This is the wave-of-500s
        // root cause for orchestrator.statusUpdate. Unclassified errors still
        // re-throw raw (→ 500) so genuine code bugs stay visible.
        if (isUpstreamServerOrNetworkError({ clientError: error, thrown: error }))
          throw throwServiceUnavailableError(ORCHESTRATOR_UNAVAILABLE_MESSAGE, error);
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

  // whatIf is a generation COST ESTIMATE (query.whatif=true); the client already
  // degrades gracefully on a failed whatIf (useWhatIfFromGraph → default cost). So
  // for whatIf we fail FAST (no 3× retry amplification) and map a transient upstream
  // brownout (network/timeout throw, or an orchestrator 5xx result) to a retry-able
  // 503 instead of a 500. The generate/write path keeps today's behavior exactly.
  const isWhatif = (query as { whatif?: boolean } | undefined)?.whatif === true;

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

  const result = await submitWorkflowWithRetry(
    {
      client,
      body: { ...body, tags: ['civitai', ...(body.tags ?? [])] },
      query,
    },
    // whatIf: 1 attempt (fail fast — avoid the 3×~30s ≈ 93s amplification on a
    // transient brownout). generate keeps the default 3 retries.
    isWhatif ? { maxAttempts: 1 } : {}
  ).catch((thrown) => {
    // With maxAttempts=1 a network/timeout failure THROWS out of the retry wrapper
    // (today that propagates raw → tRPC 500). For whatIf, classify a transient
    // upstream network/timeout error as a retry-able 503. generate (isWhatif=false)
    // re-throws unchanged = today's behavior.
    if (isWhatif && isUpstreamNetworkError(thrown))
      throw throwServiceUnavailableError(ORCHESTRATOR_UNAVAILABLE_MESSAGE, thrown);
    throw thrown;
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
        // whatIf: a transient orchestrator 5xx estimate failure → retry-able 503.
        if (isWhatif) throw throwServiceUnavailableError(ORCHESTRATOR_UNAVAILABLE_MESSAGE, error);
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
        // Genuine upstream 5xx / status-less failure. whatIf → retry-able 503;
        // generate re-throws raw (today's behavior → tRPC INTERNAL_SERVER_ERROR).
        if (isWhatif) throw throwServiceUnavailableError(ORCHESTRATOR_UNAVAILABLE_MESSAGE, error);
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
