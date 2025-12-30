import type { VideoEnhancementInput } from '@civitai/client';
import {
  invokeVideoEnhancementStepTemplate,
  invokeVideoMetadataStepTemplate,
} from '@civitai/client';
import {
  createOrchestratorClient,
  internalOrchestratorClient,
} from '~/server/services/orchestrator/client';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';

export async function enhanceVideo({ token, ...body }: VideoEnhancementInput & { token: string }) {
  const client = createOrchestratorClient(token);

  const { data, error } = await invokeVideoEnhancementStepTemplate({
    client,
    body,
  }).catch((error) => {
    throw error;
  });

  if (!data) {
    const messages = (error as any).errors?.messages?.join('\n');
    switch (error.status) {
      case 400:
        throw throwBadRequestError(messages ?? error.detail);
      case 401:
        throw throwAuthorizationError(messages ?? error.detail);
      default:
        throw new Error(messages ?? error.detail);
    }
  }

  return data;
}

export async function getVideoMetadata({ videoUrl }: { videoUrl: string }) {
  const { data, error } = await invokeVideoMetadataStepTemplate({
    client: internalOrchestratorClient,
    body: { video: videoUrl },
  });

  if (!data) {
    const messages = (error as any).errors?.messages?.join('\n');
    throw new Error(messages ?? error.detail);
  }

  return data;
}
