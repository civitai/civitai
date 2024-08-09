import { SessionUser } from 'next-auth';
import { z } from 'zod';
import {
  formatGeneratedImageResponses,
  parseGenerateImageInput,
} from '~/server/services/orchestrator/common';
import { Scheduler, TextToImageStepTemplate, type ImageJobNetworkParams } from '@civitai/client';
import { WORKFLOW_TAGS, samplersToSchedulers } from '~/shared/constants/generation.constants';
import { TextToImageResponse } from '~/server/services/orchestrator/types';
import { SignalMessages } from '~/server/common/enums';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { generateImageSchema } from '~/server/schema/orchestrator/textToImage.schema';
import { env } from '~/env/server.mjs';
import { getWorkflowDefinition } from '~/server/services/orchestrator/comfy/comfy.utils';
import { getRandomInt } from '~/utils/number-helpers';
import { generation } from '~/server/common/constants';
import { getFeatureFlags } from '~/server/services/feature-flags.service';

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

  return {
    $type: 'textToImage',
    input: {
      model: checkpoint.air,
      additionalNetworks,
      scheduler,
      ...params,
    },
    timeout: '00:10:00',
    metadata: {
      resources: input.resources,
      params: input.params,
      remix: input.remix,
    },
  } as TextToImageStepTemplate;
}

export async function createTextToImage(
  args: z.infer<typeof generateImageSchema> & { user: SessionUser; token: string }
) {
  const { params, resources, remix, tips, user } = args;
  const features = getFeatureFlags({ user });
  const metadata = { params, resources, remix };
  const step = await createTextToImageStep(args);
  const workflow = (await submitWorkflow({
    token: args.token,
    body: {
      tags: [WORKFLOW_TAGS.IMAGE, params.workflow, ...args.tags],
      steps: [step],
      tips,
      metadata,
      // @ts-ignore: ignoring until we update the civitai-client package
      experimental: features.experimentalGen ? params.experimental : undefined,
      callbacks: [
        {
          url: `${env.SIGNALS_ENDPOINT}/users/${args.user.id}/signals/${SignalMessages.TextToImageUpdate}`,
          type: ['job:*', 'workflow:*'],
        },
      ],
    },
  })) as TextToImageResponse;

  const [formatted] = await formatGeneratedImageResponses([workflow]);
  return formatted;
}
