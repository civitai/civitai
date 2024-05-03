import { ModelType } from '@prisma/client';
import { SessionUser } from 'next-auth';
import { z } from 'zod';
import {
  Sampler,
  baseModelSetTypes,
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
import { throwBadRequestError, throwInsufficientFundsError } from '~/server/utils/errorHandling';
import { includesMinor, includesNsfw, includesPoi } from '~/utils/metadata/audit';
import { stringifyAIR } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
import {
  ApiError,
  CancelablePromise,
  createCivitaiClient,
  type ImageJobNetworkParams,
  type Provider,
  type Scheduler,
  type TextToImageJobTemplate,
} from '@civitai/client';
import { env } from '~/env/server.mjs';
import { isDev } from '~/env/other';
import { samplersToSchedulers } from '~/shared/constants/generation.constants';
import { TextToImageResponse } from '~/server/services/orchestrator/types';

// #region [schemas]
const textToImageParamsSchema = z.object({
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  cfgScale: z.number(),
  sampler: z.string(),
  seed: z.number(),
  clipSkip: z.number(),
  steps: z.number(),
  quantity: z.number(),
  nsfw: z.boolean().optional(),
  draft: z.boolean().optional(),
  aspectRatio: z.coerce.number(),
  baseModel: z.enum(baseModelSetTypes),
});

const textToImageResourceSchema = z.object({
  id: z.number(),
  strength: z.number().default(1),
  triggerWord: z.string().optional(),
});

const textToImageSchema = z.object({
  params: textToImageParamsSchema,
  resources: textToImageResourceSchema
    .array()
    .min(1, 'You must select at least one resource')
    .max(10, 'Too many resources provided'),
});
// #endregion

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

  const {
    resources: resourceData,
    safeNegatives,
    minorNegatives,
    minorPositives,
  } = await getResourceDataWithInjects(parsedInput.resources.map((x) => x.id));

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
    quantity = 4;
    batchSize = params.quantity / 4;
  }

  const requestBody: TextToImageJobTemplate = {
    $type: 'textToImage',
    model: checkpoint.air,
    quantity,
    batchSize,
    additionalNetworks,
    providers: params.draft ? (env.DRAFT_MODE_PROVIDERS as Provider[] | undefined) : undefined,
    properties: { userId: user.id },
    params: {
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

  console.log(requestBody);

  const client = createCivitaiClient({
    env: isDev ? 'dev' : 'prod',
    auth: 'ff2ddeabd724b029112668447a9388f7',
  });

  return client.requests
    .submitRequest({
      include: 'Details',
      whatif: whatIf,
      requestBody,
    })
    .catch((error) => {
      // handle response errors
      if (error instanceof ApiError) {
        console.log('-------ERROR-------');
        console.dir({ error }, { depth: null });
        switch (error.status) {
          case 400:
            throw throwBadRequestError(); // TODO - better error handling
          case 403:
            throw throwInsufficientFundsError();
        }
      }
    }) as CancelablePromise<TextToImageResponse>;
}

// async function formatTextToImageResponse(data: TextToImageResponse) {}
