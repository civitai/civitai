import type { ComfyStepTemplate } from '@civitai/client';
import { NsfwLevel, TimeSpan } from '@civitai/client';
import type { SessionUser } from 'next-auth';
import type * as z from 'zod';
import { maxRandomSeed } from '~/server/common/constants';
import type { generateImageSchema } from '~/server/schema/orchestrator/textToImage.schema';
import {
  applyResources,
  getWorkflowDefinition,
  populateWorkflowDefinition,
} from '~/server/services/orchestrator/comfy/comfy.utils';
import {
  formatGenerationResponse,
  parseGenerateImageInput,
} from '~/server/services/orchestrator/common';
import type { TextToImageResponse } from '~/server/services/orchestrator/types';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { WORKFLOW_TAGS, samplersToComfySamplers } from '~/shared/constants/generation.constants';
import { Availability } from '~/shared/utils/prisma/enums';
import { getRandomInt } from '~/utils/number-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { stringifyAIR } from '~/shared/utils/air';
import { isDefined } from '~/utils/type-guards';
import { getOrchestratorCallbacks } from '~/server/orchestrator/orchestrator.utils';
import { BuzzTypes, type BuzzSpendType } from '~/shared/constants/buzz.constants';

export async function createComfyStep(
  input: z.infer<typeof generateImageSchema> & {
    user: SessionUser;
    whatIf?: boolean;
  }
) {
  const { priority, ...inputParams } = input.params;
  inputParams.seed =
    inputParams.seed ?? getRandomInt(inputParams.quantity, maxRandomSeed) - inputParams.quantity;

  const workflowDefinition = await getWorkflowDefinition(inputParams.workflow);
  if (workflowDefinition.type === 'txt2img') input.params.sourceImage = null;
  const { resources, params } = await parseGenerateImageInput({
    ...input,
    workflowDefinition,
  });

  // additional params modifications
  const { sampler, scheduler } =
    samplersToComfySamplers[
      (params.sampler as keyof typeof samplersToComfySamplers) ?? 'DPM++ 2M Karras'
    ];

  const comfyWorkflow = await populateWorkflowDefinition(inputParams.workflow, {
    ...params,
    sampler,
    scheduler,
    seed: inputParams.seed,
  });

  applyResources(
    comfyWorkflow,
    resources.map((resource) => ({
      ...resource,
      air: stringifyAIR({
        baseModel: resource.baseModel,
        type: resource.model.type,
        modelId: resource.model.id,
        id: resource.id,
      }),
    }))
  );

  const imageMetadata = JSON.stringify({
    prompt: params.prompt,
    negativePrompt: params.negativePrompt,
    steps: params.steps,
    cfgScale: params.cfgScale,
    sampler: sampler,
    seed: params.seed,
    workflowId: params.workflow,
    resources: resources.map(({ id, strength }) => ({ modelVersionId: id, strength: strength })),
    remixOfId: input.remixOfId,
  });

  const timeSpan = new TimeSpan(0, 10, 0);
  // add one minute for each additional resource minus the checkpoint
  timeSpan.addMinutes(Object.keys(resources).length - 1);
  const isPrivateGen = resources.some(
    (r) => r.availability === Availability.Private || !!r.epochDetails
  );

  return {
    $type: 'comfy',
    priority,
    input: {
      quantity: params.quantity,
      comfyWorkflow,
      imageMetadata,
      useSpineComfy: null,
    },
    timeout: timeSpan.toString(['hours', 'minutes', 'seconds']),
    metadata: {
      resources: input.resources,
      params: removeEmpty(input.params),
      remixOfId: input.remixOfId,
      isPrivateGeneration: isPrivateGen,
    },
  } as ComfyStepTemplate;
}

export async function createComfy(
  args: z.infer<typeof generateImageSchema> & {
    user: SessionUser;
    token: string;
    experimental?: boolean;
    isGreen?: boolean;
    allowMatureContent?: boolean;
    currencies: BuzzSpendType[];
  }
) {
  const step = await createComfyStep(args);
  const { user, tips, params, experimental, isGreen, allowMatureContent, currencies } = args;
  // console.log(JSON.stringify(step.input.comfyWorkflow));
  // throw new Error('stop');
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
      nsfwLevel: step.metadata?.isPrivateGeneration ? 'pg13' : undefined,
      allowMatureContent: step.metadata?.isPrivateGeneration ? false : allowMatureContent,
      // @ts-ignore - BuzzSpendType is properly supported.
      currencies: currencies ? BuzzTypes.toOrchestratorType(currencies) : undefined,
    },
  })) as TextToImageResponse;

  // console.dir(workflow, { depth: null });

  // TODO - have this use `formatComfyStep`
  const [formatted] = await formatGenerationResponse([workflow]);
  return formatted;
}
