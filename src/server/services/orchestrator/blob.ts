import type { NsfwLevel } from '@civitai/client';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';

export async function getBlobData({ token, blobId }: { token: string; blobId: string }) {
  const client = createOrchestratorClient(token);
  const { baseUrl } = client.getConfig();

  if (!baseUrl) throw new Error('invalid orchestrator client');

  const response = await fetch(`${baseUrl}/v2/consumer/blobs/${blobId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) throw new Error('unable to fetch blob data');

  return {
    nsfwLevel: response.headers.get('x-nsfw-level')?.toLocaleLowerCase() as NsfwLevel | null,
  };
}

export async function getBlobUrl() {
  //
}
