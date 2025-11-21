import { env } from '~/env/server';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';

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
    // Do nothing, not much harm.
    console.error(`Error invalidating Civitai user ${userId}:`, error);
  }
}
