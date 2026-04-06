import {
  getConsumerBlobUploadUrl,
  handleError,
  type ConsumerBlobPresignResponse,
} from '@civitai/client';
import { createOrchestratorClientNew } from '~/server/services/orchestrator/client';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';

export async function getConsumerBlobUploadUrlService({
  token,
}: {
  token: string;
}): Promise<ConsumerBlobPresignResponse> {
  const client = createOrchestratorClientNew(token);

  const { data, error } = await getConsumerBlobUploadUrl({
    client,
  }).catch((error) => {
    throw error;
  });

  if (!data) {
    const messages = handleError(error);
    switch (error.status) {
      case 400:
        throw throwBadRequestError(messages);
      case 401:
        throw throwAuthorizationError(messages);
      default:
        throw new Error(messages);
    }
  }

  return data;
}
