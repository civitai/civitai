import type { Scheduler, TextToImageStepTemplate } from '@civitai/client';
import { NsfwLevel, TimeSpan, type ImageJobNetworkParams } from '@civitai/client';
import type { SessionUser } from 'next-auth';
import type * as z from 'zod';
import { maxRandomSeed } from '~/server/common/constants';
import { getOrchestratorCallbacks } from '~/server/orchestrator/orchestrator.utils';
import type { generateImageSchema } from '~/server/schema/orchestrator/textToImage.schema';
import { getWorkflowDefinition } from '~/server/services/orchestrator/comfy/comfy.utils';
import {
  formatGenerationResponse,
  parseGenerateImageInput,
} from '~/server/services/orchestrator/common';
import type { TextToImageResponse } from '~/server/services/orchestrator/types';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { BuzzTypes, type BuzzSpendType } from '~/shared/constants/buzz.constants';
import { WORKFLOW_TAGS, samplersToSchedulers } from '~/shared/constants/generation.constants';
import { getHiDreamInput } from '~/shared/orchestrator/hidream.config';
import { Availability } from '~/shared/utils/prisma/enums';
import { getRandomInt } from '~/utils/number-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { isDefined } from '~/utils/type-guards';

export async function createTextToImageStep(
  input: z.infer<typeof generateImageSchema> & {
    user: SessionUser;
    whatIf?: boolean;
    batchAll?: boolean;
  }
) {
  const { priority, ...rest } = input.params;
  let inputParams = { ...rest };
  inputParams.seed =
    inputParams.seed ?? getRandomInt(inputParams.quantity, maxRandomSeed) - inputParams.quantity;

  if (inputParams.baseModel === 'HiDream') {
    const hiDreamResult = getHiDreamInput({ resources: input.resources, ...inputParams });
    input.resources = hiDreamResult.resources;
    inputParams = hiDreamResult.params as any;
  }

  const workflowDefinition = await getWorkflowDefinition(inputParams.workflow);

  if (workflowDefinition.type === 'txt2img') inputParams.sourceImage = null;
  const { resources, params } = await parseGenerateImageInput({
    ...input,
    params: inputParams as any,
    workflowDefinition,
  });

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

  const timeSpan = new TimeSpan(0, 20, 0);
  // add one minute for each additional resource minus the checkpoint
  timeSpan.addMinutes(Object.keys(input.resources).length - 1);

  let quantity = params.quantity;
  let batchSize = params.batchSize;
  if (!params.draft && input.batchAll) {
    quantity = 1;
    batchSize = params.quantity;
  }

  const isPrivateGeneration = resources.some(
    (r) => r.availability === Availability.Private || !!r.epochDetails
  );

  return {
    $type: 'textToImage',
    priority,
    input: {
      model: checkpoint.air,
      additionalNetworks,
      scheduler,
      ...params,
      quantity,
      batchSize,
      imageMetadata,
    },
    timeout: timeSpan.toString(['hours', 'minutes', 'seconds']),
    metadata: !input.whatIf
      ? {
          resources: input.resources,
          params: removeEmpty(inputParams),
          remixOfId: input.remixOfId,
          isPrivateGeneration,
        }
      : undefined,
  } as TextToImageStepTemplate;
}

export async function createTextToImage(
  args: z.infer<typeof generateImageSchema> & {
    user: SessionUser;
    token: string;
    experimental?: boolean;
    batchAll?: boolean;
    isGreen?: boolean;
    allowMatureContent?: boolean;
    currencies: BuzzSpendType[];
  }
) {
  const step = await createTextToImageStep(args);
  const { params, tips, user, experimental, isGreen, allowMatureContent, currencies } = args;
  const baseModel = 'baseModel' in params ? params.baseModel : undefined;
  const process = !!params.sourceImage ? 'img2img' : 'txt2img';
  const workflow = (await submitWorkflow({
    token: args.token,
    body: {
      tags: [
        WORKFLOW_TAGS.GENERATION,
        WORKFLOW_TAGS.IMAGE,
        params.workflow,
        baseModel,
        process,
        ...args.tags,
      ].filter(isDefined),
      steps: [step],
      tips,
      experimental,
      callbacks: getOrchestratorCallbacks(user.id),
      // Ensures private generation does not allow mature content
      allowMatureContent: step.metadata?.isPrivateGeneration ? false : allowMatureContent,
      // @ts-ignore - BuzzSpendType is properly supported.
      currencies: currencies ? BuzzTypes.toOrchestratorType(currencies) : undefined,
    },
  })) as TextToImageResponse;

  const [formatted] = await formatGenerationResponse([workflow], user);
  return formatted;
}
