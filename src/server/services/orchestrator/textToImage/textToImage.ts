import { SessionUser } from 'next-auth';
import { z } from 'zod';
import {
  formatGeneratedImageResponses,
  parseGenerateImageInput,
} from '~/server/services/orchestrator/common';
import {
  Scheduler,
  TextToImageStepTemplate,
  TimeSpan,
  type ImageJobNetworkParams,
} from '@civitai/client';
import { WORKFLOW_TAGS, samplersToSchedulers } from '~/shared/constants/generation.constants';
import { TextToImageResponse } from '~/server/services/orchestrator/types';
import { SignalMessages } from '~/server/common/enums';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { generateImageSchema } from '~/server/schema/orchestrator/textToImage.schema';
import { env } from '~/env/server.mjs';
import { getWorkflowDefinition } from '~/server/services/orchestrator/comfy/comfy.utils';
import { getRandomInt } from '~/utils/number-helpers';
import { generation } from '~/server/common/constants';

export async function createTextToImageStep(
  input: z.infer<typeof generateImageSchema> & {
    user: SessionUser;
  }
) {
  input.params.seed =
    input.params.seed ??
    getRandomInt(input.params.quantity, generation.maxValues.seed) - input.params.quantity;
  const workflowDefinition = await getWorkflowDefinition(input.params.workflow);
  const { resources, params } = await parseGenerateImageInput({ ...input, workflowDefinition });

  const scheduler = samplersToSchedulers[
    params.sampler as keyof typeof samplersToSchedulers
  ] as Scheduler;
  const checkpoint = resources.filter((x) => x.model.type === 'Checkpoint')[0];
  const additionalNetworks = resources
    .filter((x) => x.model.type !== 'Checkpoint')
    .reduce<Record<string, ImageJobNetworkParams>>(
      (acc, resource) => ({
        ...acc,
        [resource.air]: {
          type: resource.model.type,
          strength: resource.strength,
          triggerWord: resource.trainedWords?.[0],
        },
      }),
      {}
    );

  const imageMetadata = JSON.stringify({
    remixOfId: input.remixOfId,
  });

  const timeSpan = new TimeSpan(0, 10, 0);
  // add one minute for each additional resource minus the checkpoint
  timeSpan.addMinutes(Object.keys(input.resources).length - 1);

  return {
    $type: 'textToImage',
    input: {
      model: checkpoint.air,
      additionalNetworks,
      scheduler,
      ...params,
      imageMetadata,
    },
    timeout: timeSpan.toString(['hours', 'minutes', 'seconds']),
    metadata: {
      resources: input.resources,
      params: input.params,
      remixOfId: input.remixOfId,
    },
  } as TextToImageStepTemplate;
}

export async function createTextToImage(
  args: z.infer<typeof generateImageSchema> & {
    user: SessionUser;
    token: string;
    experimental?: boolean;
  }
) {
  const { params, tips, user, experimental } = args;
  const step = await createTextToImageStep(args);
  const workflow = (await submitWorkflow({
    token: args.token,
    body: {
      tags: [WORKFLOW_TAGS.IMAGE, params.workflow, ...args.tags],
      steps: [step],
      tips,
      // @ts-ignore: ignoring until we update the civitai-client package
      experimental: true,
      callbacks: [
        {
          url: `${env.SIGNALS_ENDPOINT}/users/${user.id}/signals/${SignalMessages.TextToImageUpdate}`,
          type: ['job:*', 'workflow:*'],
        },
      ],
    },
  })) as TextToImageResponse;

  const [formatted] = await formatGeneratedImageResponses([workflow]);
  return formatted;
}
