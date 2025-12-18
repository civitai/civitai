import type { ImageGenStepTemplate } from '@civitai/client';
import { NsfwLevel, TimeSpan } from '@civitai/client';
import type { SessionUser } from 'next-auth';
import type * as z from 'zod';
import { getOrchestratorCallbacks } from '~/server/orchestrator/orchestrator.utils';
import type { generateImageSchema } from '~/server/schema/orchestrator/textToImage.schema';
import { formatGenerationResponse } from '~/server/services/orchestrator/common';
import type { TextToImageResponse } from '~/server/services/orchestrator/types';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { BuzzTypes, type BuzzSpendType } from '~/shared/constants/buzz.constants';
import type { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';
import { imageGenConfig } from '~/shared/orchestrator/ImageGen/imageGen.config';

export async function createImageGenStep(
  args: z.infer<typeof generateImageSchema> & {
    user: SessionUser;
  },
  config?: ReturnType<typeof ImageGenConfig>
) {
  const { priority } = args.params;
  const timeSpan = new TimeSpan(0, 10, 0);

  if (!config) {
    config = imageGenConfig[args.params.engine as keyof typeof imageGenConfig];
    if (!config) throw new Error(`missing config for engine: ${args.params.engine}`);
  }

  const input = args.whatIf
    ? config.getStepInput(args)
    : ({
        ...config.getStepInput(args),
        imageMetadata: config.getImageMetadata(args),
      } as ReturnType<typeof config.getStepInput>);

  const metadata = args.whatIf ? {} : config.getStepMetadata(args);

  return {
    $type: 'imageGen',
    priority,
    input,
    timeout: timeSpan.toString(['hours', 'minutes', 'seconds']),
    metadata,
  } as ImageGenStepTemplate;
}

export async function createImageGen(
  args: z.infer<typeof generateImageSchema> & {
    user: SessionUser;
    token: string;
    experimental?: boolean;
    isGreen?: boolean;
    allowMatureContent?: boolean;
    currencies: BuzzSpendType[];
  }
) {
  const { tips, user, experimental, isGreen, allowMatureContent, currencies } = args;
  if (!args.params.engine)
    throw new Error(`cannot generate with $type:'imageGen' without specifying an engine`);
  const config = imageGenConfig[args.params.engine as keyof typeof imageGenConfig];
  if (!config) throw new Error(`missing 'imageGen' config for engine: '${args.params.engine}'`);

  const step = await createImageGenStep(args, config);
  const tags = config.getTags(args);

  const workflow = (await submitWorkflow({
    token: args.token,
    body: {
      tags,
      steps: [step],
      tips,
      experimental,
      callbacks: getOrchestratorCallbacks(user.id),
      allowMatureContent: step.metadata?.isPrivateGeneration ? false : allowMatureContent,
      // @ts-ignore - BuzzSpendType is properly supported.
      currencies: currencies ? BuzzTypes.toOrchestratorType(currencies) : undefined,
    },
  })) as TextToImageResponse;

  const [formatted] = await formatGenerationResponse([workflow], user);
  return formatted;
}
