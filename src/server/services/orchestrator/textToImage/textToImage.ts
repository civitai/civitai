import { SessionUser } from 'next-auth';
import { z } from 'zod';
import {
  generationParamsToOrchestrator,
  getResourceDataWithInjects,
  validateGenerationResources,
} from '~/server/services/orchestrator/common';
import { parseAIR } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
import {
  Scheduler,
  TextToImageInput,
  TextToImageStepTemplate,
  WorkflowStatus,
  WorkflowTemplate,
  type ImageJobNetworkParams,
} from '@civitai/client';
import {
  WORKFLOW_TAGS,
  formatGenerationResources,
  getBaseModelSetType,
  getInjectablResources,
  samplersToSchedulers,
} from '~/shared/constants/generation.constants';
import { TextToImageResponse } from '~/server/services/orchestrator/types';
import { SignalMessages } from '~/server/common/enums';
import { queryWorkflows, submitWorkflow } from '~/server/services/orchestrator/workflows';
import {
  textToImageCreateSchema,
  textToImageWhatIfSchema,
} from '~/server/schema/orchestrator/textToImage.schema';
import { deepOmit, removeNulls } from '~/utils/object-helpers';
import dayjs from 'dayjs';
import { env } from '~/env/server.mjs';
import { getWorkflowDefinition } from '~/server/services/orchestrator/comfy/comfy.utils';

export async function textToImage({
  user,
  whatIf,
  token,
  ...input
}: z.input<typeof textToImageCreateSchema> & {
  user: SessionUser;
  whatIf?: boolean;
  token: string;
}) {
  const parsedInput = textToImageCreateSchema.parse(input);
  const { tags, metadata = {}, workflowKey, params } = parsedInput;
  const { checkpoint, resources, injectable, status } = await validateGenerationResources({
    user,
    ...parsedInput,
  });

  const workflowDefinition = await getWorkflowDefinition(workflowKey);
  const mapped = await generationParamsToOrchestrator({
    workflowDefinition,
    params,
    resources,
    injectable,
    status,
    user,
  });

  const additionalNetworks = [...resources, ...mapped.resourcesToInject]
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
  metadata.params = mapped.metadataParams;

  const step: TextToImageStepTemplate = {
    $type: 'textToImage',
    metadata: deepOmit(metadata),
    input: {
      model: checkpoint.air,
      additionalNetworks,
      scheduler: samplersToSchedulers[
        params.sampler as keyof typeof samplersToSchedulers
      ] as Scheduler,
      ...mapped.params,
    },
  };

  const body: WorkflowTemplate = {
    tags: [WORKFLOW_TAGS.IMAGE, WORKFLOW_TAGS.TEXT_TO_IMAGE, ...tags],
    steps: [step],
    callbacks: !whatIf
      ? [
          {
            url: `${env.SIGNALS_ENDPOINT}/users/${user.id}/signals/${SignalMessages.TextToImageUpdate}`,
            type: ['job:*', 'workflow:*'],
          },
        ]
      : undefined,
  };

  const workflow = (await submitWorkflow({
    token,
    body,
    query: {
      whatif: whatIf,
    },
  })) as TextToImageResponse;

  return { workflow, resources, injectable };
}

export async function createTextToImage(
  args: z.input<typeof textToImageCreateSchema> & { user: SessionUser; token: string }
) {
  const { workflow, resources, injectable } = await textToImage(args);

  // console.dir(workflow, { depth: null });
  const [formatted] = await formatTextToImageResponses([workflow], { resources, injectable });
  return formatted;
}

export type TextToImageWhatIf = AsyncReturnType<typeof whatIfTextToImage>;
export async function whatIfTextToImage({
  resources,
  user,
  token,
  workflowKey,
  ...params
}: z.input<typeof textToImageWhatIfSchema> & { user: SessionUser; token: string }) {
  const { workflow } = await textToImage({
    params,
    resources: resources.map((id) => ({ id })),
    whatIf: true,
    user,
    token,
    workflowKey,
  });

  let cost = 0,
    ready = true,
    eta = dayjs().add(10, 'minutes').toDate(),
    position = 0;

  for (const step of workflow.steps) {
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

export async function getTextToImageRequests(
  props: Parameters<typeof queryWorkflows>[0] & { token: string }
) {
  const { nextCursor, items } = await queryWorkflows({
    ...props,
    tags: [WORKFLOW_TAGS.IMAGE, WORKFLOW_TAGS.TEXT_TO_IMAGE, ...(props.tags ?? [])],
  });

  return {
    items: await formatTextToImageResponses(items as TextToImageResponse[]),
    nextCursor,
  };
}

// #region [helper methods]
export async function formatTextToImageResponses(
  workflows: TextToImageResponse[],
  resources?: AsyncReturnType<typeof getResourceDataWithInjects>
) {
  const textToImageAirs = getTextToImageAirs(
    workflows.flatMap((x) => x.steps.flatMap((s) => s.input))
  );
  const { resources: resourcesData, injectable: allInjectable } =
    resources ?? (await getResourceDataWithInjects(textToImageAirs.map((x) => x.version)));

  // TODO - abstract this in a way that it can be more reusable
  return workflows.map((workflow) => {
    const steps = workflow.steps;
    if (!steps) throw new Error(`no steps in workflow: ${workflow.id}`);

    const formattedSteps = steps.map((step) => {
      const airs = getTextToImageAirs([step.input]);
      const versionIds = airs.map((x) => x.version);
      const stepResources = resourcesData
        .filter((x) => versionIds.includes(x.id))
        .map((resource) => {
          const networkParams = airs.find((x) => x.version === resource.id)?.networkParams;
          return {
            ...resource,
            ...networkParams,
          };
        });

      const resources = formatGenerationResources(stepResources);

      const checkpoint = stepResources.find((x) => x.model.type === 'Checkpoint');
      const baseModel = getBaseModelSetType(checkpoint?.baseModel);
      const injectable = getInjectablResources(baseModel);

      const { input, output, jobs, metadata } = step;
      const images =
        output?.images
          ?.map((image, i) => {
            const seed = step.input.seed;
            const job = jobs?.find((x) => x.id === image.jobId);
            if (!job) return null;
            return {
              workflowId: workflow.id as string,
              stepName: step.name ?? '$0',
              jobId: job.id,
              id: image.id,
              status: job.status ?? ('unassignend' as WorkflowStatus),
              seed: seed ? seed + i : undefined,
              completed: job.completedAt ? new Date(job.completedAt) : undefined,
              url: image.url,
            };
          })
          .filter(isDefined) ?? [];

      let prompt = input.prompt ?? '';
      let negativePrompt = input.negativePrompt ?? '';
      for (const item of Object.values(injectable).filter(isDefined)) {
        const resource = allInjectable.find((x) => x.id === item.id);
        if (!resource) continue;
        const triggerWord = resource.trainedWords?.[0];
        if (triggerWord) {
          if (item?.triggerType === 'negative')
            negativePrompt = negativePrompt.replace(`${triggerWord}, `, '');
          if (item?.triggerType === 'positive') prompt = prompt.replace(`${triggerWord}, `, '');
        }
      }

      // infer draft from resources if not included in meta params
      const isDraft =
        metadata?.params?.draft ??
        (injectable.draft ? versionIds.includes(injectable.draft.id) : false);

      // infer nsfw from resources if not included in meta params
      const isNsfw = metadata?.params?.nsfw ?? !versionIds.includes(injectable.civit_nsfw.id);

      let quantity = input.quantity ?? 1;
      if (isDraft) {
        quantity *= 4;
      }

      const cost = step.jobs
        ? Math.ceil(step.jobs.reduce((acc, job) => acc + (job.cost ?? 0), 0))
        : 0;

      const sampler = Object.entries(samplersToSchedulers).find(
        ([sampler, scheduler]) => scheduler.toLowerCase() === input.scheduler?.toLowerCase()
      )?.[0];

      return removeNulls({
        $type: 'textToImage',
        name: step.name ?? '$0',
        params: {
          baseModel,
          prompt,
          negativePrompt,
          quantity,
          controlNets: input.controlNets,
          sampler,
          steps: input.steps,
          cfgScale: input.cfgScale,
          width: input.width,
          height: input.height,
          seed: input.seed,
          clipSkip: input.clipSkip,
          draft: isDraft,
          nsfw: isNsfw,
        },
        resources,
        images,
        cost,
        status: step.status,
        metadata: metadata,
      });
    });

    return {
      id: workflow.id as string,
      status: workflow.status ?? ('unassignend' as WorkflowStatus),
      createdAt: workflow.createdAt ? new Date(workflow.createdAt) : new Date(),
      totalCost: Math.ceil(
        workflow.steps?.flatMap((x) => x.jobs ?? [])?.reduce((acc, job) => acc + (job.cost ?? 0), 0)
      ),
      steps: formattedSteps,
      tags: workflow.tags,
    };
  });
}

function getTextToImageAirs(inputs: TextToImageInput[]) {
  return Object.entries(
    inputs.reduce<Record<string, ImageJobNetworkParams>>((acc, input) => {
      acc[input.model] = {};
      const additionalNetworks = input.additionalNetworks ?? {};
      for (const key in additionalNetworks) acc[key] = additionalNetworks[key];
      return acc;
    }, {})
  ).map(([air, networkParams]) => ({ ...parseAIR(air), networkParams }));
}
// #endregion
