import { NSFWLevel, headBlob } from '@civitai/client';

import { createOrchestratorClient } from '~/server/services/orchestrator/common';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwInternalServerError,
} from '~/server/utils/errorHandling';

export const nsfwNsfwLevels: NSFWLevel[] = ['r', 'x', 'xxx'];
export async function getBlobData({ token, blobId }: { token: string; blobId: string }) {
  const client = createOrchestratorClient(token);

  const { error, response } = await headBlob({
    client,
    path: { blobId },
  }).catch((error) => {
    throw error;
  });
  if (error) {
    switch (error.status) {
      case 400:
        throw throwBadRequestError(error.detail);
      case 401:
        throw throwAuthorizationError(error.detail);

      default:
        if (error.detail?.startsWith('<!DOCTYPE'))
          throw throwInternalServerError('Generation services down');
        throw error;
    }
  }

  return {
    nsfwLevel: response.headers.get('x-nsfw-level')?.toLocaleLowerCase() as NSFWLevel | null,
  };
}
