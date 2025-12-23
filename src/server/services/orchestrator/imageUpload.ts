import { NsfwLevel, handleError, invokeImageUploadStepTemplate } from '@civitai/client';
import { createOrchestratorClientNew } from '~/server/services/orchestrator/client';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';
import { isMature } from '~/shared/constants/orchestrator.constants';

export async function imageUpload({
  sourceImage,
  token,
  allowMatureContent,
}: {
  sourceImage: string;
  token: string;
  allowMatureContent?: boolean;
}) {
  const client = createOrchestratorClientNew(token);

  const { data, error } = await invokeImageUploadStepTemplate({
    client,
    body: sourceImage,
    query: { allowMatureContent },
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

  const { nsfwLevel } = data.blob;

  if (allowMatureContent === false && isMature(nsfwLevel))
    throw new Error('mature content not allowed');

  return data;
}
