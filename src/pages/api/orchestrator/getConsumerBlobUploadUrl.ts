import { TRPCError } from '@trpc/server';
import { logToAxiom } from '~/server/logging/client';
import { getConsumerBlobUploadUrlService } from '~/server/services/orchestrator/consumerBlobUpload';
import { OrchestratorEndpoint } from '~/server/utils/endpoint-helpers';

// The client retries only 429/5xx, so an upstream outage must not arrive as a 403 denial.
function presignErrorStatus(e: unknown) {
  if (e instanceof TRPCError) {
    if (e.code === 'UNAUTHORIZED') return 403;
    if (e.code === 'BAD_REQUEST') return 400;
    if (e.code === 'TOO_MANY_REQUESTS') return 429;
  }
  return 502;
}

const MAX_LOGGED_MESSAGE_LENGTH = 300;
const truncate = (value: unknown) =>
  typeof value === 'string' ? value.slice(0, MAX_LOGGED_MESSAGE_LENGTH) : undefined;

/**
 * Records a presign that failed upstream. Without it these 502s left no trace on our side.
 *
 * Severity `warning`, not `error`: an upstream outage fails every presign at once, the same
 * wave shape for which `handleEndpointError` keeps 503s off the error stream.
 *
 * Bounded fields only. A cause message can be an upstream error page, so messages are
 * truncated, and no token, request or response body is logged.
 */
function logPresignFailure(e: unknown, userId: number) {
  const err = (e ?? {}) as { name?: unknown; message?: unknown; cause?: unknown };
  // The cause is whatever the orchestrator client returned: an Error, a raw string, or a
  // problem-details object (which TRPCError wraps in an Error carrying its fields).
  const rawCause = err.cause;
  const cause = (rawCause !== null && typeof rawCause === 'object' ? rawCause : {}) as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    status?: unknown;
    detail?: unknown;
  };
  logToAxiom(
    {
      type: 'warning',
      name: 'consumer-blob-presign-failed',
      userId,
      code: e instanceof TRPCError ? e.code : undefined,
      errorName: truncate(err.name),
      errorMessage: truncate(err.message),
      causeName: truncate(cause.name),
      causeCode: truncate(cause.code),
      // A problem-details body carries the upstream status; the route answers 502 for all.
      causeStatus: typeof cause.status === 'number' ? cause.status : undefined,
      causeMessage: truncate(typeof rawCause === 'string' ? rawCause : cause.message),
      causeDetail: truncate(cause.detail),
    },
    'civitai-prod'
  ).catch(() => undefined);
}

export default OrchestratorEndpoint(
  async function handler(req, res, user, token) {
    try {
      const result = await getConsumerBlobUploadUrlService({ token });
      return res.status(200).json(result);
    } catch (e) {
      const status = presignErrorStatus(e);
      // 4xx are expected (signed out, denied, throttled); only an upstream failure is logged.
      if (status === 502) logPresignFailure(e, user.id);
      // Only the 4xx texts are written for the user; an upstream failure's may not be.
      return res
        .status(status)
        .send(status === 502 ? 'Failed to get upload URL' : (e as Error).message);
    }
  },
  ['GET']
);
