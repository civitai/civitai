import { env } from '~/env/server';
import { createOrchestratorClient } from '~/server/services/orchestrator/common';

export async function invalidateCivitaiUser({ userId }: { userId: number | string }) {
  if (!env.ORCHESTRATOR_ACCESS_TOKEN) {
    return;
  }

  const client = createOrchestratorClient(env.ORCHESTRATOR_ACCESS_TOKEN!);
  try {
    await client.delete({
      url: `/v2/consumers/civitai/${userId}`,
    });
  } catch (error) {
    console.error(`Failed to invalidate Civitai user ${userId}:`, error);
    // We don't need to throw here, just log the error
  }
}
