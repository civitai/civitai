import { env } from '~/env/server';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';
import { logToAxiom, safeError } from '~/server/logging/client';

async function deleteOrchestratorUserCache(userId: number | string, url: string) {
  if (!env.ORCHESTRATOR_ACCESS_TOKEN) {
    return;
  }

  try {
    const client = createOrchestratorClient(env.ORCHESTRATOR_ACCESS_TOKEN!);
    await client.delete({ url });
  } catch (error) {
    // Best-effort: a failure leaves the orchestrator serving a stale cache, so surface it to Axiom
    // instead of failing silently. Never throws (callers `await` this inside user-facing mutations).
    logToAxiom({
      type: 'orchestrator.invalidate-user.failed',
      message: `orchestrator cache invalidation (${url}) failed for user ${userId}`,
      error: safeError(error),
    }).catch(() => {});
  }
}

/** Refreshes the orchestrator's cached user info (membership, profile). Leaves cached auth alone. */
export async function invalidateCivitaiUser({ userId }: { userId: number | string }) {
  await deleteOrchestratorUserCache(userId, `/v2/consumer/civitai/${userId}`);
}

/**
 * Makes the orchestrator re-validate every API key and OAuth token of the user it has cached for
 * auth. Call after revoking any of them; invalidateCivitaiUser does not touch that cache.
 */
export async function revokeCivitaiUserTokens({ userId }: { userId: number | string }) {
  await deleteOrchestratorUserCache(userId, `/v2/consumer/civitai/${userId}/tokens`);
}
