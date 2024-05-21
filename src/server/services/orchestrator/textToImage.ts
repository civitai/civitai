import { ModelType } from '@prisma/client';
import { SessionUser } from 'next-auth';
import { z } from 'zod';
import {
  BaseModel,
  BaseModelSetType,
  Sampler,
  baseModelSets,
  draftMode,
  getGenerationConfig,
} from '~/server/common/constants';
import { extModeration } from '~/server/integrations/moderation';
import { logToAxiom } from '~/server/logging/client';
import {
  ResourceData,
  getGenerationStatus,
  getResourceDataWithInjects,
} from '~/server/services/orchestrator/common';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { includesMinor, includesNsfw, includesPoi } from '~/utils/metadata/audit';
import { parseAIR, stringifyAIR } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
import {
  TextToImageStep,
  Workflow,
  type ImageJobNetworkParams,
  type Scheduler,
} from '@civitai/client';
import { samplersToSchedulers } from '~/shared/constants/generation.constants';
import { CallbackSource, TextToImageResponse } from '~/server/services/orchestrator/types';
import { RecommendedSettingsSchema } from '~/server/schema/model-version.schema';
import { SignalMessages } from '~/server/common/enums';
import { queryWorkflows, submitWorkflow } from '~/server/services/orchestrator/workflows';
import { textToImageSchema } from '~/server/schema/orchestrator/textToImage.schema';

export async function textToImage({
  user,
  whatIf,
  ...input
}: z.input<typeof textToImageSchema> & { user: SessionUser; whatIf?: boolean }) {
  const parsedInput = textToImageSchema.parse(input);
  const { params } = parsedInput;

  const status = await getGenerationStatus();
  if (!status.available && !user.isModerator)
    throw throwBadRequestError('Generation is currently disabled');

  const limits = status.limits[user.tier ?? 'free'];
  if (params.quantity > limits.quantity) params.quantity = limits.quantity;
  if (params.steps > limits.steps) params.steps = limits.steps;
  if (parsedInput.resources.length > limits.resources)
    throw throwBadRequestError('You have exceeded the resources limit.');

  // handle draft mode
  const isSDXL =
    params.baseModel === 'SDXL' ||
    params.baseModel === 'Pony' ||
    params.baseModel === 'SDXLDistilled';

  const draftModeSettings = draftMode[isSDXL ? 'sdxl' : 'sd1'];
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

  type AirResourceData = ReturnType<typeof airify>[number];
  function airify(resources: ResourceData[]) {
    return resources
      .map((resource) => {
        const air = stringifyAIR({
          baseModel: resource.baseModel,
          type: resource.model.type,
          source: 'civitai',
          modelId: resource.model.id,
          id: resource.id,
        });
        if (!air) return null;
        return { ...resource, ...parsedInput.resources.find((x) => x.id === resource.id), air };
      })
      .filter(isDefined);
  }

  const resources = airify(resourceData);

  // #region [error handling]
  // handle missing checkpoint
  const checkpoint = resources.find((x) => x.model.type === ModelType.Checkpoint);
  if (!checkpoint)
    throw throwBadRequestError('A checkpoint is required to make a generation request');

  // handle missing draft resource
  if (params.draft && !resources.map((x) => x.id).includes(draftModeSettings.resourceId))
    throw throwBadRequestError(`Draft mode is currently disabled for ${params.baseModel} models`);

  // TODO - ensure that draft mode models are included in the `GenerationCoverage` view
  // handle missing coverage
  if (
    !resources.every(
      (x) => !!x.generationCoverage?.covered || x.id === draftModeSettings.resourceId
    )
  )
    throw throwBadRequestError(
      `Some of your resources are not available for generation: ${resources
        .filter((x) => !(!!x.generationCoverage?.covered || x.id === draftModeSettings.resourceId))
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
  const { height, width } = config.aspectRatios[params.aspectRatio];
  const availableResourceTypes = config.additionalResourceTypes.map((x) => x.type);
  const additionalNetworks: { [key: string]: ImageJobNetworkParams } = {};
  function addAdditionalNetwork(resource: AirResourceData) {
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
  if (isSDXL) params.clipSkip = 2;

  // adjust quantity/batchSize for draft mode
  let quantity = params.quantity;
  let batchSize = 1;
  if (params.draft) {
    quantity = Math.ceil(params.quantity / 4);
    batchSize = Math.ceil(params.quantity / 4) * 4;
  }

  const step: TextToImageStep = {
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

  const requestBody: Workflow = {
    steps: [step],
    callbacks: [
      {
        url: `https://signals-dev.civitai.com/users/${user.id}/${SignalMessages.OrchestratorUpdate}`,
        type: [`${CallbackSource.job}:*`],
      },
    ],
  };

  const workflow = (await submitWorkflow({
    whatif: whatIf,
    requestBody,
    user,
  })) as TextToImageResponse;

  return await formatTextToImageResponses([workflow], resourceDataWithInjects);
}

export async function getTextToImageRequests(
  props: Omit<Parameters<typeof queryWorkflows>[0], 'jobType'>
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

// #region [helper methods]
const baseModelSetsEntries = Object.entries(baseModelSets);
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
      const baseModel = checkpoint
        ? (baseModelSetsEntries.find(([, v]) =>
            v.includes(checkpoint.baseModel as BaseModel)
          )?.[0] as BaseModelSetType)
        : undefined;

      const resources = requestResources.map((resource) => {
        const settings = resource.settings as RecommendedSettingsSchema;
        return {
          id: resource.id,
          name: resource.name,
          trainedWords: resource.trainedWords,
          modelId: resource.model.id,
          modelName: resource.model.name,
          modelType: resource.model.type,
          baseModel: resource.baseModel,
          strength: settings?.strength ?? 1,
          minStrength: settings?.minStrength ?? -1,
          maxStrength: settings?.maxStrength ?? 2,
          covered: resource.generationCoverage?.covered,
        };
      });

      return steps.map((step) => {
        const { input, output, jobs, status } = step;
        const images =
          output?.images
            ?.map((image, i) => {
              const seed = step.input.seed;
              const job = jobs?.find((x) => x.id === ''); // TODO - match with image jobId
              if (!job) return null;
              return {
                // requestId: workflow.id,
                jobId: job.id,
                id: image.blobKey,
                available: image.available,
                status: job.status,
                seed: seed ? seed + i : undefined,
                completed: new Date() as Date | undefined, // TODO - get from job?
                url: '', // TODO - update after sdk update
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

        return {
          id: workflow.id,
          status: workflow.status,
          // createdAt: workflow.dateTime, // TODO - do I need this?
          params: {
            baseModel,
            prompt,
            negativePrompt,
            quantity: input.quantity,
            controlNets: input.controlNets,
            scheduler: input.scheduler,
            steps: input.steps,
            cfgScale: input.cfgScale,
            width: input.width,
            height: input.height,
            seed: input.seed,
            clipSkip: input.clipSkip,
          },
          resources,
          images,
          cost: workflow.transactions?.reduce((acc, value) => acc + (value.amount ?? 0), 0),
        };
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
