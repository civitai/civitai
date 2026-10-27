import { env } from '~/env/server';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';
import { logToAxiom, safeError } from '~/server/logging/client';

const DELETE_TIMEOUT_MS = 5_000;

/** True only when the orchestrator answered 2xx. */
async function deleteOrchestratorUserCache(userId: number | string, url: string) {
  if (!env.ORCHESTRATOR_ACCESS_TOKEN) {
    return false;
  }

  try {
    const client = createOrchestratorClient(env.ORCHESTRATOR_ACCESS_TOKEN!);
    // Without throwOnError the client resolves on an error status.
    await client.delete({
      url,
      throwOnError: true,
      signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
    });
    return true;
  } catch (error) {
    // Best-effort: a failure leaves the orchestrator serving a stale cache, so surface it to Axiom
    // instead of failing silently. Never throws (callers `await` this inside user-facing mutations).
    logToAxiom({
      type: 'orchestrator.invalidate-user.failed',
      message: `orchestrator cache invalidation (${url}) failed for user ${userId}`,
      error: safeError(error),
    }).catch(() => {});
    return false;
  }
}

/** Refreshes the orchestrator's cached user info (membership, profile). Leaves cached auth alone. */
export async function invalidateCivitaiUser({ userId }: { userId: number | string }) {
  return deleteOrchestratorUserCache(userId, `/v2/consumer/civitai/${userId}`);
}

/**
 * Makes the orchestrator re-validate every API key and OAuth token of the user it has cached for
 * auth. Call after revoking any of them; invalidateCivitaiUser does not touch that cache.
 */
export async function revokeCivitaiUserTokens({ userId }: { userId: number | string }) {
  return deleteOrchestratorUserCache(userId, `/v2/consumer/civitai/${userId}/tokens`);
}
