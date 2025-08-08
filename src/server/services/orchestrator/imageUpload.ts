import { handleError, invokeImageUploadStepTemplate } from '@civitai/client';
import { createOrchestratorClient } from '~/server/services/orchestrator/common';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';

export async function imageUpload({ sourceImage, token }: { sourceImage: string; token: string }) {
  const client = createOrchestratorClient(token);

  const { data, error } = await invokeImageUploadStepTemplate({
    client,
    body: sourceImage,
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
