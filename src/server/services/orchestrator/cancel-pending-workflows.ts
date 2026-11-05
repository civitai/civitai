import { env } from '~/env/server';
import { logToAxiom, safeError } from '~/server/logging/client';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';

const CANCEL_ATTEMPTS = 2;
/** The caller's wait. A cancel still running past it finishes in the background. */
export const CANCEL_PENDING_DEADLINE_MS = 5_000;
// Long, not the caller's wait: aborting the request stops the orchestrator part-way through the
// account's workflows. Calling again is safe.
const REQUEST_TIMEOUT_MS = 60_000;

const CANCEL_PATCH = JSON.stringify([{ op: 'replace', path: '/status', value: 'canceled' }]);

async function requestCancel(userId: number) {
  if (!env.ORCHESTRATOR_ENDPOINT || !env.ORCHESTRATOR_ACCESS_TOKEN)
    throw new Error('The orchestrator is not configured');
  const response = await fetch(
    `${env.ORCHESTRATOR_ENDPOINT}/v1/manager/users/${userId}/workflows`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${env.ORCHESTRATOR_ACCESS_TOKEN}`,
        'Content-Type': 'application/json-patch+json',
      },
      body: CANCEL_PATCH,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );
  if (!response.ok) throw new Error(`Orchestrator answered ${response.status}`);
}

async function cancelAll(userId: number) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CANCEL_ATTEMPTS; attempt++) {
    try {
      return await requestCancel(userId);
    } catch (error) {
      lastError = error;
    }
  }
  await Promise.resolve()
    .then(() =>
      logToAxiom({
        name: 'mute.cancel-workflows-failed',
        type: 'error',
        userId,
        error: safeError(lastError),
      })
    )
    .catch(() => undefined);
}

/**
 * Cancels every one of the account's workflows not yet finished. Jobs already running may still
 * complete. Never throws, and waits at most `CANCEL_PENDING_DEADLINE_MS`.
 */
export async function cancelPendingWorkflows(userId: number): Promise<void> {
  await withTimeoutFallback(cancelAll(userId), CANCEL_PENDING_DEADLINE_MS, undefined);
}
