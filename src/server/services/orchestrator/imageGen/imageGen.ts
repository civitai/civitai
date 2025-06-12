import type { ImageGenStepTemplate } from '@civitai/client';
import { TimeSpan } from '@civitai/client';
import type { SessionUser } from 'next-auth';
import type { z } from 'zod';
import { env } from '~/env/server';
import { SignalMessages } from '~/server/common/enums';
import type { generateImageSchema } from '~/server/schema/orchestrator/textToImage.schema';
import { formatGenerationResponse } from '~/server/services/orchestrator/common';
import type { TextToImageResponse } from '~/server/services/orchestrator/types';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { findClosest, getRandomInt } from '~/utils/number-helpers';
import { removeEmpty } from '~/utils/object-helpers';
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
  const engine = 'engine' in args.params ? (args.params.engine as string) : undefined;
  const baseModel = 'baseModel' in args.params ? (args.params.baseModel as string) : undefined;
  const process =
    'sourceImage' in args.params && typeof args.params.sourceImage === 'object'
      ? 'img2img'
      : 'txt2img';
  const workflow = (await submitWorkflow({
    token: args.token,
    body: {
      tags: [
        WORKFLOW_TAGS.GENERATION,
        WORKFLOW_TAGS.IMAGE,
        engine,
        baseModel,
        process,
        ...args.tags,
      ].filter(isDefined),
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
        // quality: params.openAIQuality,
        background: params.openAITransparentBackground ? 'transparent' : 'opaque',
        quality: params.openAIQuality,
        quantity: Math.min(params.quantity, 10),
        size: Object.values(
          getClosestOpenAISize(
            params.sourceImage?.width ?? params.width,
            params.sourceImage?.height ?? params.height
          )
        ).join('x'),
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
        baseModel: params.baseModel,
        prompt: params.prompt,
        // quality: params.openAIQuality,
        background: params.openAITransparentBackground ? 'transparent' : 'opaque',
        quality: params.openAIQuality,
        quantity: Math.min(params.quantity, 10),
        workflow: params.workflow,
        sourceImage: params.sourceImage,
        process: !params.sourceImage ? 'txt2img' : 'img2img',
        ...getClosestOpenAISize(
          params.sourceImage?.width ?? params.width,
          params.sourceImage?.height ?? params.height
        ),
      });
    default:
      throw new Error('imageGen step type not implemented');
  }
}

const openAISizes = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
];
function getClosestOpenAISize(w: number, h: number) {
  const ratios = openAISizes.map(({ width, height }) => width / height);
  const closest = findClosest(ratios, w / h);
  const index = ratios.indexOf(closest);
  const { width, height } = openAISizes[index] ?? openAISizes[0];
  return { width, height };
}

// const openAISizes = ['1024x1024', '1536x1024', '1024x1536'];
// function getClosestOpenAISize(width: number, height: number) {
//   const ratios = openAISizes.map((size) => {
//     const [width, height] = size.split('x').map(Number);
//     return width / height;
//   });
//   const closest = findClosest(ratios, width / height);
//   const index = ratios.indexOf(closest);
//   return openAISizes[index] ?? openAISizes[0];
// }
