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

  console.log(client.getConfig().baseUrl);

  const response = await fetch(`${client.getConfig().baseUrl}/v2/consumer/blobs/${blobId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) throw new Error('unable to fetch blob data');

  return {
    nsfwLevel: response.headers.get('x-nsfw-level')?.toLocaleLowerCase() as NSFWLevel | null,
  };

  // const { error, data, response, request } = await headBlob({
  //   client,
  //   path: { blobId },
  // }).catch((error) => {
  //   console.log('--------------------------');
  //   throw error;
  // });
  // if (error) {
  //   switch (error.status) {
  //     case 400:
  //       throw throwBadRequestError(error.detail);
  //     case 401:
  //       throw throwAuthorizationError(error.detail);

  //     default:
  //       if (error.detail?.startsWith('<!DOCTYPE'))
  //         throw throwInternalServerError('Generation services down');
  //       throw error;
  //   }
  // }

  // return {
  //   nsfwLevel: response.headers.get('x-nsfw-level')?.toLocaleLowerCase() as NSFWLevel | null,
  // };
}
