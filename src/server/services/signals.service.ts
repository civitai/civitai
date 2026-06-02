import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type { GetSignalsAccessTokenResponse } from '~/server/schema/signals.schema';
import { SignalsCallTimeoutError, withSignals } from '~/server/signals/wrapper';
import { throwBadRequestError } from '~/server/utils/errorHandling';

export async function getAccessToken({ id }: GetByIdInput) {
  // if (isProd) logToAxiom({ type: 'signals', id }, 'connection-testing').catch();
  if (!env.SIGNALS_ENDPOINT) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Signals service is not configured',
    });
  }

  // Wrap the signals HTTP fetch with the per-call timeout + concurrency limit
  // + circuit breaker. Without this, a signals brownout makes signals.getToken
  // block the event loop until Traefik's 30s router timeout — the failure mode
  // that drove the 2026-05-30 api-primary SIGKILL cascade. Mirror PR #2362's
  // Meili wrap pattern. Translate SignalsCallTimeoutError to TRPCError(TIMEOUT)
  // so the client gets a fast 408 instead of hanging.
  let response: Response;
  try {
    response = await withSignals(() =>
      fetch(`${env.SIGNALS_ENDPOINT}/users/${id}/accessToken`)
    );
  } catch (err) {
    if (err instanceof SignalsCallTimeoutError) {
      throw new TRPCError({
        code: 'TIMEOUT',
        message: 'Signals temporarily overloaded — retrying.',
        cause: err,
      });
    }
    throw err;
  }
  if (!response.ok) {
    switch (response.status) {
      case 400:
        throw throwBadRequestError();
      default:
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error ocurred, please try again later',
        });
    }
  }

  const data: GetSignalsAccessTokenResponse = await response.json();
  return data;
}
