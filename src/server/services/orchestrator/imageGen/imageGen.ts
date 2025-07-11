import type { ImageGenStepTemplate } from '@civitai/client';
import { TimeSpan } from '@civitai/client';
import type { SessionUser } from 'next-auth';
import type * as z from 'zod/v4';
import { env } from '~/env/server';
import { SignalMessages } from '~/server/common/enums';
import type { generateImageSchema } from '~/server/schema/orchestrator/textToImage.schema';
import { formatGenerationResponse } from '~/server/services/orchestrator/common';
import type { TextToImageResponse } from '~/server/services/orchestrator/types';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
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
  }
) {
  const { tips, user, experimental } = args;
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
