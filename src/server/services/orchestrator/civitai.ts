import { env } from '~/env/server';
import { createOrchestratorClient } from '~/server/services/orchestrator/common';

export async function invalidateCivitaiUser({ userId }: { userId: number | string }) {
  if (!env.ORCHESTRATOR_ACCESS_TOKEN) {
    return;
  }

  const client = createOrchestratorClient(env.ORCHESTRATOR_ACCESS_TOKEN!);
  await client.delete({
    url: `/v2/consumer/civitai/${userId}`,
  });
}
