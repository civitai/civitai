import { ModelType } from '@prisma/client';
import { SessionUser } from 'next-auth';
import { z } from 'zod';
import { Sampler, getGenerationConfig } from '~/server/common/constants';
import { extModeration } from '~/server/integrations/moderation';
import { logToAxiom } from '~/server/logging/client';
import {
  AirResourceData,
  getGenerationStatus,
  getResourceDataWithInjects,
} from '~/server/services/orchestrator/common';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { includesMinor, includesNsfw, includesPoi } from '~/utils/metadata/audit';
import { parseAIR, stringifyAIR } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
import {
  TextToImageStepTemplate,
  WorkflowStatus,
  WorkflowTemplate,
  type ImageJobNetworkParams,
  type Scheduler,
} from '@civitai/client';
import {
  formatGenerationResources,
  getBaseModelSetType,
  getDraftModeSettings,
  getIsSdxl,
  samplersToSchedulers,
} from '~/shared/constants/generation.constants';
import { TextToImageResponse } from '~/server/services/orchestrator/types';
import { SignalMessages } from '~/server/common/enums';
import {
  deleteManyWorkflows,
  queryWorkflows,
  submitWorkflow,
  updateManyWorkflows,
} from '~/server/services/orchestrator/workflows';
import {
  TextToImageWorkflowMetadata,
  TextToImageWorkflowUpdateSchema,
  textToImageSchema,
  textToImageWhatIfSchema,
} from '~/server/schema/orchestrator/textToImage.schema';
import { removeNulls } from '~/utils/object-helpers';
import { ResourceData } from '~/server/redis/caches';
import dayjs from 'dayjs';

export async function textToImage({
  user,
  whatIf,
  token,
  ...input
}: z.input<typeof textToImageSchema> & { user: SessionUser; whatIf?: boolean; token: string }) {
  const parsedInput = textToImageSchema.parse(input);
  const { params } = parsedInput;

  const status = await getGenerationStatus();
  if (!status.available && !user.isModerator)
    throw throwBadRequestError('Generation is currently disabled');

  const limits = status.limits[user.tier ?? 'free'];
  if (params.quantity > limits.quantity) params.quantity = limits.quantity;
  if (params.steps > limits.steps) params.steps = limits.steps;
  if (parsedInput.resources.length > limits.resources)
    throw throwBadRequestError('You have exceed the number of allowed resources.');

  // handle draft mode
  const draftModeSettings = getDraftModeSettings(params.baseModel);
  if (params.draft) {
    // Fix quantity
    if (params.quantity % 4 !== 0) params.quantity = Math.ceil(params.quantity / 4) * 4;
    // Fix other params
    params.steps = draftModeSettings.steps;
    params.cfgScale = draftModeSettings.cfgScale;
    params.sampler = draftModeSettings.sampler;
    // Add speed up resources
    parsedInput.resources.push({
      strength: 1,
      id: draftModeSettings.resourceId,
      // baseModel: draftModeSettings.baseModel,
    });
  }

  const resourceDataWithInjects = await getResourceDataWithInjects(
    parsedInput.resources.map((x) => x.id)
  );

  const {
    resources: resourceData,
    safeNegatives,
    minorNegatives,
    minorPositives,
  } = resourceDataWithInjects;

  type ResourceData = ReturnType<typeof airify>[number];
  // TODO - rename
  function airify(resources: AirResourceData[]) {
    return resources.map((resource) => ({
      ...resource,
      ...parsedInput.resources.find((x) => x.id === resource.id),
      triggerWord: resource.trainedWords?.[0],
    }));
  }

  const resources = airify(resourceData);

  // #region [error handling]
  // handle missing checkpoint
  const checkpoint = resources.find((x) => x.model.type === ModelType.Checkpoint);
  if (!checkpoint)
    throw throwBadRequestError('A checkpoint is required to make a generation request');
  if (params.baseModel !== getBaseModelSetType(checkpoint.baseModel))
    throw throwBadRequestError(
      `Invalid base model. Checkpoint with baseModel: ${checkpoint.baseModel} does not match the input baseModel: ${params.baseModel}`
    );

  // handle missing draft resource
  if (params.draft && !resources.map((x) => x.id).includes(draftModeSettings.resourceId))
    throw throwBadRequestError(`Draft mode is currently disabled for ${params.baseModel} models`);

  // TODO - ensure that draft mode models are included in the `GenerationCoverage` view
  // handle missing coverage
  if (!resources.every((x) => !!x.covered || x.id === draftModeSettings.resourceId))
    throw throwBadRequestError(
      `Some of your resources are not available for generation: ${resources
        .filter((x) => !(!!x.covered || x.id === draftModeSettings.resourceId))
        .map((x) => x.air)
        .join(', ')}`
    );

  // handle moderate prompt
  try {
    const moderationResult = await extModeration.moderatePrompt(params.prompt);
    if (moderationResult.flagged) {
      throw throwBadRequestError(
        `Your prompt was flagged for: ${moderationResult.categories.join(', ')}`
      );
    }
  } catch (error: any) {
    logToAxiom({ name: 'external-moderation-error', type: 'error', message: error.message });
  }
  // #endregion

  const config = getGenerationConfig(params.baseModel);
  const { height, width } = config.aspectRatios[Number(params.aspectRatio)];
  const availableResourceTypes = config.additionalResourceTypes.map((x) => x.type);
  const additionalNetworks: { [key: string]: ImageJobNetworkParams } = {};
  function addAdditionalNetwork(resource: ResourceData) {
    additionalNetworks[resource.air] = {
      type: resource.model.type,
      strength: resource.strength,
      triggerWord: resource.triggerWord,
    };
  }

  for (const resource of resources.filter((x) => availableResourceTypes.includes(x.model.type))) {
    addAdditionalNetwork(resource);
  }

  // Set nsfw to true if the prompt contains nsfw words
  const isPromptNsfw = includesNsfw(params.prompt);
  params.nsfw ??= isPromptNsfw !== false;

  // Disable nsfw if the prompt contains poi/minor words
  const hasPoi = includesPoi(params.prompt) || resources.some((x) => x.model.poi);
  if (hasPoi || includesMinor(params.prompt)) params.nsfw = false;

  const negativePrompts = [params.negativePrompt ?? ''];
  if (!params.nsfw && status.sfwEmbed) {
    for (const resource of airify(safeNegatives)) {
      addAdditionalNetwork(resource);
      if (resource.triggerWord) negativePrompts.unshift(resource.triggerWord);
    }
  }

  // Inject fallback minor safety nets
  const positivePrompts = [params.prompt];
  if (isPromptNsfw && status.minorFallback) {
    for (const resource of airify(minorPositives)) {
      addAdditionalNetwork(resource);
      if (resource.triggerWord) positivePrompts.unshift(resource.triggerWord);
    }
    for (const resource of airify(minorNegatives)) {
      addAdditionalNetwork(resource);
      if (resource.triggerWord) negativePrompts.unshift(resource.triggerWord);
    }
  }

  // handle SDXL ClipSkip
  // I was made aware that SDXL only works with clipSkip 2
  // if that's not the case anymore, we can rollback to just setting
  // this for Pony resources -Manuel
  if (getIsSdxl(params.baseModel)) params.clipSkip = 2;

  // adjust quantity/batchSize for draft mode
  let quantity = params.quantity;
  let batchSize = 1;
  if (params.draft) {
    quantity = Math.ceil(params.quantity / 4);
    batchSize = 4;
  }

  const step: TextToImageStepTemplate = {
    $type: 'textToImage',
    input: {
      model: checkpoint.air,
      quantity,
      batchSize,
      additionalNetworks,
      // providers: params.draft ? (env.DRAFT_MODE_PROVIDERS as Provider[] | undefined) : undefined, // TODO - ??
      prompt: positivePrompts.join(', '),
      negativePrompt: negativePrompts.join(', '),
      scheduler: samplersToSchedulers[params.sampler as Sampler] as Scheduler,
      steps: params.steps,
      cfgScale: params.cfgScale,
      seed: params.seed,
      clipSkip: params.clipSkip,
      width,
      height,
    },
  };

  const requestBody: WorkflowTemplate = {
    steps: [step],
    callbacks: !whatIf
      ? [
          {
            url: `https://signals-dev.civitai.com/users/${user.id}/signals/${SignalMessages.TextToImageUpdate}`, // TODO - env var?
            type: ['job:*', 'workflow:*'],
          },
        ]
      : undefined,
  };

  const workflow = (await submitWorkflow({
    whatif: whatIf,
    requestBody,
    token,
  })) as TextToImageResponse;

  return { workflow, resourceDataWithInjects };
}

export async function createTextToImage(
  args: z.input<typeof textToImageSchema> & { user: SessionUser; token: string }
) {
  const { workflow, resourceDataWithInjects } = await textToImage(args);

  // console.dir(workflow, { depth: null });
  const [formatted] = await formatTextToImageResponses([workflow], resourceDataWithInjects);
  return formatted;
}

export type TextToImageWhatIf = AsyncReturnType<typeof whatIfTextToImage>;
export async function whatIfTextToImage({
  resources,
  user,
  token,
  ...params
}: z.input<typeof textToImageWhatIfSchema> & { user: SessionUser; token: string }) {
  const { workflow } = await textToImage({
    params,
    resources: resources.map((id) => ({ id })),
    whatIf: true,
    user,
    token,
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
  // console.dir(workflow, { depth: null });

  return {
    cost: Math.ceil(cost),
    ready,
    eta,
    position,
  };
}

export async function getTextToImageRequests(
  props: Omit<Parameters<typeof queryWorkflows>[0], 'jobType'> & { token: string }
) {
  const { nextCursor, items } = await queryWorkflows({
    ...props,
    jobType: ['textToImage'],
  });

  return {
    items: await formatTextToImageResponses(items as TextToImageResponse[]),
    nextCursor,
  };
}

export async function updateTextToImageWorkflow({
  workflows,
  token,
}: {
  workflows: TextToImageWorkflowUpdateSchema[];
  token: string;
}) {
  const { toDelete, toUpdate } = workflows.reduce<{
    toDelete: string[];
    toUpdate: Omit<TextToImageWorkflowUpdateSchema, 'imageCount'>[];
  }>(
    (acc, { workflowId, metadata, imageCount }) => {
      if (Object.values(metadata.images ?? {}).filter((x) => x.hidden).length === imageCount)
        acc.toDelete.push(workflowId);
      else acc.toUpdate.push({ workflowId, metadata });
      return acc;
    },
    { toDelete: [], toUpdate: [] }
  );
  if (toDelete.length) await deleteManyWorkflows({ workflowIds: toDelete, token });
  if (toUpdate.length) await updateManyWorkflows({ workflows: toUpdate, token });
}

// #region [helper methods]
export async function formatTextToImageResponses(
  workflows: TextToImageResponse[],
  resources?: AsyncReturnType<typeof getResourceDataWithInjects>
) {
  const {
    resources: resourcesData,
    safeNegatives,
    minorNegatives,
    minorPositives,
  } = resources ?? (await getResourceDataWithInjects(getAirs(workflows).map((x) => x.version)));

  return workflows
    .map((workflow) => {
      const steps = workflow.steps;
      if (!steps) throw new Error(`no steps in workflow: ${workflow.id}`);

      const airs = getAirs([workflow]);
      const versionIds = airs.map((x) => x.version);
      const requestResources = resourcesData.filter((x) => versionIds.includes(x.id));
      const checkpoint = requestResources.find((x) => x.model.type === 'Checkpoint');
      const baseModel = getBaseModelSetType(checkpoint?.baseModel);

      const resources = formatGenerationResources(requestResources);

      return steps.map((step) => {
        const { input, output, jobs } = step;
        const images =
          output?.images
            ?.map((image, i) => {
              const seed = step.input.seed;
              const job = jobs?.find((x) => x.id === image.jobId);
              if (!job) return null;
              return {
                workflowId: workflow.id,
                jobId: job.id,
                id: image.id,
                status: job.status ?? ('unassignend' as WorkflowStatus),
                seed: seed ? seed + i : undefined,
                completed: job.completedAt ? new Date(job.completedAt) : undefined,
                url: image.url,
              };
            })
            .filter(isDefined) ?? [];

        let negativePrompt = input.negativePrompt ?? '';
        for (const { triggerWord } of [...safeNegatives, ...minorNegatives]) {
          negativePrompt = negativePrompt.replace(`${triggerWord}, `, '');
        }

        let prompt = input.prompt ?? '';
        for (const { triggerWord } of [...minorPositives]) {
          prompt = prompt.replace(`${triggerWord}, `, '');
        }

        const draftModeSettings = baseModel ? getDraftModeSettings(baseModel) : undefined;
        const isDraft = draftModeSettings
          ? !!resources.find((x) => x.id === draftModeSettings.resourceId)
          : false;

        let quantity = input.quantity ?? 1;
        if (isDraft) {
          quantity *= 4;
        }

        return removeNulls({
          id: workflow.id as string,
          status: workflow.status ?? ('unassignend' as WorkflowStatus),
          createdAt: workflow.createdAt ? new Date(workflow.createdAt) : new Date(),
          params: {
            baseModel,
            prompt,
            negativePrompt,
            quantity,
            controlNets: input.controlNets,
            scheduler: input.scheduler,
            steps: input.steps,
            cfgScale: input.cfgScale,
            width: input.width,
            height: input.height,
            seed: input.seed,
            clipSkip: input.clipSkip,
            isDraft,
          },
          resources,
          images,
          cost: Math.ceil(
            workflow.steps
              ?.flatMap((x) => x.jobs ?? [])
              ?.reduce((acc, job) => acc + (job.cost ?? 0), 0)
          ),
          metadata: workflow.metadata as TextToImageWorkflowMetadata | undefined,
        });
      });
    })
    .flat();
}

// TODO - do I need to support keys not in an air format? probably yes
// force return air from orchestrator?
function getAirs(workflows: TextToImageResponse[]) {
  return Object.keys(
    workflows.reduce<Record<string, boolean>>((acc, workflow) => {
      for (const step of workflow.steps.flat() ?? []) {
        const { input } = step;
        acc[input.model] = true;
        for (const key in input.additionalNetworks ?? {}) acc[key] = true;
      }
      return acc;
    }, {})
  ).map((air) => parseAIR(air));
}
// #endregion
