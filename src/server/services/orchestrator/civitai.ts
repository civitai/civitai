import { env } from '~/env/server';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';
import { logToAxiom, safeError } from '~/server/logging/client';

export async function invalidateCivitaiUser({ userId }: { userId: number | string }) {
  if (!env.ORCHESTRATOR_ACCESS_TOKEN) {
    return;
  }

  try {
    const client = createOrchestratorClient(env.ORCHESTRATOR_ACCESS_TOKEN!);
    await client.delete({
      url: `/v2/consumer/civitai/${userId}`,
    });
  } catch (error) {
    // Best-effort: this runs on key/token revocation and session changes, so a
    // failure means the orchestrator keeps serving a stale auth cache until
    // TTL — exactly the 24h-lingering bug. Surface to Axiom so we can spot it
    // in prod instead of failing silently. Never throws (callers `await` this
    // inside user-facing mutations).
    logToAxiom({
      type: 'orchestrator.invalidate-user.failed',
      message: `invalidateCivitaiUser failed for user ${userId}`,
      error: safeError(error),
    }).catch(() => {});
  }
}
