import {
  getConsumerBlobUploadUrl,
  handleError,
  type ConsumerBlobPresignResponse,
} from '@civitai/client';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwRateLimitError,
} from '~/server/utils/errorHandling';

export async function getConsumerBlobUploadUrlService({
  token,
}: {
  token: string;
}): Promise<ConsumerBlobPresignResponse> {
  const client = createOrchestratorClient(token);

  const { data, error, response } = await getConsumerBlobUploadUrl({
    client,
  }).catch((error) => {
    throw error;
  });

  if (!data) {
    // A throttle or proxy error may carry no problem-details body, so read the HTTP status.
    const messages = error ? handleError(error) : undefined;
    switch (response?.status ?? error?.status) {
      case 400:
        throw throwBadRequestError(messages);
      case 401:
      case 403:
        throw throwAuthorizationError(messages);
      case 429:
        throw throwRateLimitError(messages);
      default:
        throw new Error(messages);
    }
  }

  return data;
}
