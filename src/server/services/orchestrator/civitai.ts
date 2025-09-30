import { env } from '~/env/server';
import { internalClients } from '~/server/services/orchestrator/common';

export async function invalidateCivitaiUser({ userId }: { userId: number | string }) {
  if (!env.ORCHESTRATOR_ACCESS_TOKEN) {
    return;
  }

  for (const client of internalClients) {
    await client.delete({
      url: `/v2/consumers/civitai/${userId}`,
    });
  }
}
