import { postV2ConsumerRecipesImageUpload } from '@civitai/client';
import { createOrchestratorClient } from '~/server/services/orchestrator/common';
import { throwBadRequestError } from '~/server/utils/errorHandling';

export async function imageUpload({ sourceImage, token }: { sourceImage: string; token: string }) {
  const client = createOrchestratorClient(token);

  const { data, error } = await postV2ConsumerRecipesImageUpload({
    client,
    body: sourceImage,
  }).catch((error) => {
    throw error;
  });

  if (!data) {
    if (error.status === 400) {
      const messages = (error as any).error.messages;
      throw throwBadRequestError(messages.join('\n'));
    } else throw throwBadRequestError(error.title);
  }

  return data;
}
