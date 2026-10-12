import {
  getConsumerBlobUploadUrl,
  handleError,
  type ConsumerBlobPresignResponse,
} from '@civitai/client';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';
import { throwOrchestratorFailure } from '~/server/services/orchestrator/workflows';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

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
    // A throttle or proxy error may carry no problem-details body.
    const message = error ? handleError(error) : undefined;
    // A presign 403 is a denial, not the insufficient-funds meaning it has on paid calls.
    if (response?.status === 403) throw throwAuthorizationError(message);
    throwOrchestratorFailure({ error, response, message });
  }

  return data;
}
