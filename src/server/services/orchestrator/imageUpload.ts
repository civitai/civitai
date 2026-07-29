import { NsfwLevel, handleError, invokeImageUploadStepTemplate } from '@civitai/client';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwServiceUnavailableError,
} from '~/server/utils/errorHandling';
import { isMature } from '~/shared/constants/orchestrator.constants';

export async function imageUpload({
  sourceImage,
  token,
  allowMatureContent,
}: {
  sourceImage: string;
  token: string;
  allowMatureContent?: boolean;
}) {
  const client = createOrchestratorClient(token);

  const { data, error } = await invokeImageUploadStepTemplate({
    client,
    body: sourceImage,
    query: { allowMatureContent },
  }).catch((error) => {
    throw error;
  });

  if (!data) {
    const messages = handleError(error);
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? (error as { status?: number }).status
        : undefined;
    switch (status) {
      case 400:
        throw throwBadRequestError(messages);
      case 401:
        throw throwAuthorizationError(messages);
      default:
        // A genuine upstream 5xx (orchestrator HTTP 500/502/503/504) OR a status-less
        // network/timeout failure (no HTTP status — the TCP/DNS/TLS layer failed
        // before any response) is a TRANSIENT dependency outage, NOT this app's own
        // fault. Mirror #3047 (training) / #2978 (submit): surface it as a retry-able
        // 503 SERVICE_UNAVAILABLE with the ORIGINAL error preserved as `cause`,
        // instead of a plain `Error` that tRPC wraps into a generic
        // INTERNAL_SERVER_ERROR (500) with an EMPTY cause chain. That masked-cause 500
        // is exactly what surfaced ~178×/h and CLIMBING on orchestrator.imageUpload
        // (2026-07-10): a degrading upload backend mis-counted against our 500 SLO AND
        // non-retryable to the client. This block is only reached on a `!data` result
        // from the orchestrator round-trip, so a local/logic bug thrown BEFORE the
        // call never reaches here — only real upstream failures do.
        if (status === undefined || status >= 500)
          throw throwServiceUnavailableError(messages ?? null, error);
        // Any OTHER unexpected non-5xx status is a real, non-transient anomaly — keep
        // it a hard error so a genuine bug is NOT silently masked as a retry-able 503.
        throw new Error(messages);
    }
  }

  const { nsfwLevel } = data.blob;

  // A mature blob when the caller disallowed mature content is a USER-CONTENT
  // rejection (client fault), not a server fault — surface it as a 400 BAD_REQUEST,
  // not a plain Error that tRPC maps to a 500.
  if (allowMatureContent === false && isMature(nsfwLevel))
    throw throwBadRequestError('mature content not allowed');

  return data;
}
