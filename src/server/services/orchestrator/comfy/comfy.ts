import { ComfyStepTemplate, TimeSpan } from '@civitai/client';
import { SessionUser } from 'next-auth';
import { z } from 'zod';
import { env } from '~/env/server';
import { maxRandomSeed } from '~/server/common/constants';
import { SignalMessages } from '~/server/common/enums';
import { generateImageSchema } from '~/server/schema/orchestrator/textToImage.schema';
import {
  applyResources,
  getWorkflowDefinition,
  populateWorkflowDefinition,
} from '~/server/services/orchestrator/comfy/comfy.utils';
import {
  formatGenerationResponse,
  parseGenerateImageInput,
} from '~/server/services/orchestrator/common';
import { TextToImageResponse } from '~/server/services/orchestrator/types';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { WORKFLOW_TAGS, samplersToComfySamplers } from '~/shared/constants/generation.constants';
import { getRandomInt } from '~/utils/number-helpers';
import { stringifyAIR } from '~/utils/string-helpers';

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

  return {
    $type: 'comfy',
    priority,
    input: {
      quantity: params.quantity,
      comfyWorkflow,
      imageMetadata,
    },
    timeout: timeSpan.toString(['hours', 'minutes', 'seconds']),
    metadata: {
      resources: input.resources,
      params: input.params,
      remixOfId: input.remixOfId,
    },
  } as ComfyStepTemplate;
}

export async function createComfy(
  args: z.infer<typeof generateImageSchema> & {
    user: SessionUser;
    token: string;
    experimental?: boolean;
  }
) {
  const { user, tips, params, experimental } = args;
  const step = await createComfyStep(args);
  // console.log(JSON.stringify(step.input.comfyWorkflow));
  // throw new Error('stop');
  const workflow = (await submitWorkflow({
    token: args.token,
    body: {
      tags: [WORKFLOW_TAGS.GENERATION, WORKFLOW_TAGS.IMAGE, params.workflow, ...args.tags],
      steps: [step],
      tips,
      experimental: env.ORCHESTRATOR_EXPERIMENTAL,
      callbacks: [
        {
          url: `${env.SIGNALS_ENDPOINT}/users/${user.id}/signals/${SignalMessages.TextToImageUpdate}`,
          type: ['job:*', 'workflow:*'],
        },
      ],
    },
  })) as TextToImageResponse;

  // console.dir(workflow, { depth: null });

  // TODO - have this use `formatComfyStep`
  const [formatted] = await formatGenerationResponse([workflow]);
  return formatted;
}
