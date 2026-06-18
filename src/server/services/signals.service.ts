import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';
import { logToAxiom, safeError } from '~/server/logging/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type { GetSignalsAccessTokenResponse } from '~/server/schema/signals.schema';
import { SignalsCallTimeoutError, withSignals } from '~/server/signals/wrapper';
import { throwBadRequestError } from '~/server/utils/errorHandling';

// Degraded result returned when the signals service is transiently
// unavailable. `accessToken` is absent → useSignalsWorker reads
// `data?.accessToken` as undefined, never opens the SignalR connection, and
// retries (the `connection:state === 'closed'` path re-invalidates the query).
const SIGNALS_UNAVAILABLE: GetSignalsAccessTokenResponse = {};

/**
 * Emit a structured fail-soft warning for a signals-token mint that degraded
 * instead of 500-ing. Mirrors logSysRedisFailOpen so ops can dashboard/alert
 * on the same `type: 'warning'` shape — a sustained spike means real-time
 * signals are effectively down for users, even though no request is failing.
 * Fire-and-forget: never blocks (or fails) the calling request.
 */
function logSignalsFailSoft(reason: string, err: unknown, extra?: Record<string, unknown>) {
  logToAxiom({
    ...safeError(err),
    ...extra,
    name: 'signals-fail-soft',
    type: 'warning',
    subtype: 'token-mint-degraded',
    reason,
    fn: 'getAccessToken',
  }).catch(() => {
    /* fail-soft logger never blocks the request */
  });
}

export async function getAccessToken({ id }: GetByIdInput) {
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
  // Meili wrap pattern.
  //
  // FAIL SOFT: real-time signals are non-critical. A transient signals-service
  // unavailability (Orleans crashloop / connection reset → `fetch failed`,
  // per-call timeout, or open circuit) must NOT 500 the user's request — it's
  // the single biggest steady-state 500 contributor on dp-prod. On any such
  // failure we log a structured warning (so ops still see it) and return a
  // degraded `{}` the client already tolerates. We deliberately do NOT swallow
  // a 400 (a real bad-request / client error, not a transient outage).
  let response: Response;
  try {
    response = await withSignals(() =>
      fetch(`${env.SIGNALS_ENDPOINT}/users/${id}/accessToken`)
    );
  } catch (err) {
    logSignalsFailSoft(
      err instanceof SignalsCallTimeoutError ? `circuit-${err.reason}` : 'fetch-failed',
      err,
      { userId: id }
    );
    return SIGNALS_UNAVAILABLE;
  }
  if (!response.ok) {
    if (response.status === 400) throw throwBadRequestError();
    logSignalsFailSoft('non-ok-response', undefined, { userId: id, status: response.status });
    return SIGNALS_UNAVAILABLE;
  }

  try {
    const data: GetSignalsAccessTokenResponse = await response.json();
    return data;
  } catch (err) {
    // Signals returned 200 but a malformed/empty body — degrade rather than 500.
    logSignalsFailSoft('bad-json', err, { userId: id });
    return SIGNALS_UNAVAILABLE;
  }
}
