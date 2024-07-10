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
import {
  generateImageSchema,
  generateImageWhatIfSchema,
} from '~/server/schema/orchestrator/textToImage.schema';
import dayjs from 'dayjs';
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

  return {
    $type: 'textToImage',
    input: {
      model: checkpoint.air,
      additionalNetworks,
      scheduler,
      ...params,
    },
  } as TextToImageStepTemplate;
}

export async function createTextToImage(
  args: z.infer<typeof generateImageSchema> & { user: SessionUser; token: string }
) {
  const { params, resources, remix } = args;
  const metadata = { params, resources, remix };
  const step = await createTextToImageStep(args);
  const workflow = (await submitWorkflow({
    token: args.token,
    body: {
      tags: [WORKFLOW_TAGS.IMAGE, args.params.workflow, ...args.tags],
      steps: [step],
      metadata,
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

export type TextToImageWhatIf = AsyncReturnType<typeof whatIfTextToImage>;
export async function whatIfTextToImage(
  args: z.infer<typeof generateImageWhatIfSchema> & { user: SessionUser; token: string }
) {
  const step = await createTextToImageStep({
    ...args,
    resources: args.resources.map((id) => ({ id, strength: 1 })),
  });
  const workflow = await submitWorkflow({
    token: args.token,
    body: {
      steps: [step],
    },
  });

  let cost = 0,
    ready = true,
    eta = dayjs().add(10, 'minutes').toDate(),
    position = 0;

  for (const step of workflow.steps ?? []) {
    for (const job of step.jobs ?? []) {
      cost += job.cost;

      const { queuePosition } = job;
      if (!queuePosition) continue;

      const { precedingJobs, startAt, support } = queuePosition;
      if (support !== 'available' && ready) ready = false;
      if (precedingJobs && precedingJobs < position) {
        position = precedingJobs;
        if (startAt && new Date(startAt).getTime() < eta.getTime()) eta = new Date(startAt);
      }
    }
  }

  return {
    cost: Math.ceil(cost),
    ready,
    eta,
    position,
  };
}

// export async function getTextToImageRequests(
//   props: Parameters<typeof queryWorkflows>[0] & { token: string }
// ) {
//   const { nextCursor, items } = await queryWorkflows({
//     ...props,
//     tags: [WORKFLOW_TAGS.IMAGE, WORKFLOW_TAGS.TEXT_TO_IMAGE, ...(props.tags ?? [])],
//   });

//   return {
//     items: await formatTextToImageResponses(items as TextToImageResponse[]),
//     nextCursor,
//   };
// }
