import { ComfyStepTemplate } from '@civitai/client';
import { SessionUser } from 'next-auth';
import { z } from 'zod';
import { env } from '~/env/server.mjs';
import { SignalMessages } from '~/server/common/enums';
import { textToImageCreateSchema } from '~/server/schema/orchestrator/textToImage.schema';
import {
  applyResources,
  getWorkflowDefinition,
  populateWorkflowDefinition,
} from '~/server/services/orchestrator/comfy/comfy.utils';
import {
  generationParamsToOrchestrator,
  validateGenerationResources,
} from '~/server/services/orchestrator/common';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { WORKFLOW_TAGS, samplersToComfySamplers } from '~/shared/constants/generation.constants';

export async function createComfyStep({
  user,
  token,
  ...input
}: z.infer<typeof textToImageCreateSchema> & {
  user: SessionUser;
  token: string;
}) {
  const { resources, injectable, status } = await validateGenerationResources({
    user,
    ...input,
  });

  const workflowDefinition = await getWorkflowDefinition(input.workflowKey);
  const { params, ...mapped } = await generationParamsToOrchestrator({
    workflowDefinition,
    params: input.params,
    resources,
    injectable,
    status,
    user,
  });

  const { sampler, scheduler } =
    samplersToComfySamplers[params.sampler as keyof typeof samplersToComfySamplers];

  const allResources = [...resources, ...mapped.resourcesToInject];
  const comfyWorkflow = await populateWorkflowDefinition(input.workflowKey, {
    ...params,
    sampler,
    scheduler,
    seed: params.seed ?? -1,
  });
  applyResources(comfyWorkflow, allResources);
  const step: ComfyStepTemplate = { $type: 'comfy', input: { comfyWorkflow } };

  return { step, resources, injectable, tags: [workflowDefinition.key] };
}

export async function createComfy(
  args: z.infer<typeof textToImageCreateSchema> & { user: SessionUser; token: string }
) {
  const { user } = args;
  const { step, resources, injectable, tags } = await createComfyStep(args);
  const workflow = await submitWorkflow({
    token: args.token,
    body: {
      tags: [WORKFLOW_TAGS.IMAGE, ...tags],
      steps: [step],
      callbacks: [
        {
          url: `${env.SIGNALS_ENDPOINT}/users/${user.id}/signals/${SignalMessages.TextToImageUpdate}`,
          type: ['job:*', 'workflow:*'],
        },
      ],
    },
  });
  console.dir(workflow, { depth: null });
}
