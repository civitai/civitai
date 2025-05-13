import {
  ImageGenStepTemplate,
  Scheduler,
  TextToImageStepTemplate,
  TimeSpan,
  type ImageJobNetworkParams,
} from '@civitai/client';
import type { SessionUser } from 'next-auth';
import { z } from 'zod';
import { env } from '~/env/server';
import { maxRandomSeed } from '~/server/common/constants';
import { SignalMessages } from '~/server/common/enums';
import { generateImageSchema } from '~/server/schema/orchestrator/textToImage.schema';
import { getWorkflowDefinition } from '~/server/services/orchestrator/comfy/comfy.utils';
import {
  formatGenerationResponse,
  parseGenerateImageInput,
} from '~/server/services/orchestrator/common';
import { TextToImageResponse } from '~/server/services/orchestrator/types';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { WORKFLOW_TAGS, samplersToSchedulers } from '~/shared/constants/generation.constants';
import { Availability } from '~/shared/utils/prisma/enums';
import { getRandomInt } from '~/utils/number-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { stringifyAIR } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

export async function createImageGenStep(
  input: z.infer<typeof generateImageSchema> & {
    user: SessionUser;
  }
) {
  const { priority, ...inputParams } = input.params;
  const timeSpan = new TimeSpan(0, 10, 0);
  const { remixOfId } = input;

  const imageMetadata = {
    ...getImageGenMetadataParams(inputParams),
    resources: input.resources.map(({ id, strength }) => ({
      modelVersionId: id,
      strength: strength,
    })),
    remixOfId,
  };

  return {
    $type: 'imageGen',
    priority,
    input: {
      ...getImageGenInput(inputParams),
      imageMetadata: imageMetadata,
    },
    timeout: timeSpan.toString(['hours', 'minutes', 'seconds']),
    metadata: {
      resources: input.resources,
      params: getImageGenMetadataParams(inputParams),
      remixOfId: input.remixOfId,
    },
  } as ImageGenStepTemplate;
}

export async function createImageGen(
  args: z.infer<typeof generateImageSchema> & {
    user: SessionUser;
    token: string;
    experimental?: boolean;
  }
) {
  const { tips, user, experimental } = args;
  const step = await createImageGenStep(args);
  const workflow = (await submitWorkflow({
    token: args.token,
    body: {
      tags: [WORKFLOW_TAGS.GENERATION, WORKFLOW_TAGS.IMAGE, ...args.tags].filter(isDefined),
      steps: [step],
      tips,
      experimental,
      callbacks: [
        {
          url: `${env.SIGNALS_ENDPOINT}/users/${user.id}/signals/${SignalMessages.TextToImageUpdate}`,
          type: ['job:*', 'workflow:*'],
        },
      ],
    },
  })) as TextToImageResponse;

  const [formatted] = await formatGenerationResponse([workflow], user);
  return formatted;
}

type InputParams = Omit<z.infer<typeof generateImageSchema>['params'], 'priority'>;
function getImageGenInput(params: InputParams) {
  switch (params.engine) {
    case 'openai':
      return {
        engine: 'openai',
        model: 'gpt-image-1',
        operation: !params.sourceImage ? 'createImage' : 'editImage',
        images: params.sourceImage ? [params.sourceImage.url] : undefined,
        prompt: params.prompt,
        size: !params.sourceImage ? `${params.width}x${params.height}` : undefined,
        // quality: params.openAIQuality,
        background: params.openAITransparentBackground ? 'transparent' : 'opaque',
        quality: params.openAIQuality,
        quantity: Math.min(params.quantity, 10),
      };
    default:
      throw new Error('imageGen step type not implemented');
  }
}

function getImageGenMetadataParams(params: InputParams) {
  switch (params.engine) {
    case 'openai':
      return removeEmpty({
        engine: 'openai',
        prompt: params.prompt,
        width: params.width,
        height: params.height,
        // quality: params.openAIQuality,
        background: params.openAITransparentBackground ? 'transparent' : 'opaque',
        quality: params.openAIQuality,
        quantity: Math.min(params.quantity, 10),
        workflow: params.workflow,
        sourceImage: params.sourceImage,
      });
    default:
      throw new Error('imageGen step type not implemented');
  }
}
