/**
 * Flux Family Ecosystem Handler
 *
 * Handles Flux family workflows:
 * - Flux1, FluxKrea
 *
 * Uses textToImage step type for standard generation,
 * different handling for draft/pro/ultra modes.
 */

import type {
  ImageGenStepTemplate,
  ImageJobNetworkParams,
  PreprocessImageStepTemplate,
  Scheduler,
  TextToImageStepTemplate,
} from '@civitai/client';
import type {
  ComfyFlux1CreateImageGenInput,
  Flux1ProImageGenInput,
  Flux1ProUltraImageGenInput,
} from '@civitai/orchestration-client';
import { maxRandomSeed } from '~/server/common/constants';
import {
  fluxUltraAir,
  getClosestFluxUltraAspectRatioLabel,
  samplersToComfySamplers,
  samplersToSchedulers,
} from '~/shared/constants/generation.constants';
import { removeEmpty } from '~/utils/object-helpers';
import { getRandomInt } from '~/utils/number-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ControlNetsNodeValue } from '~/shared/data-graph/generation/common';
import { defineHandler } from './handler-factory';
import { buildControlNetSteps } from './controlnets.helper';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type FluxCtx = EcosystemGraphOutput & {
  ecosystem: 'Flux1' | 'FluxKrea';
};

// =============================================================================
// Constants
// =============================================================================

/** Flux mode version IDs */
const FLUX_VERSION_IDS = {
  draft: 699279,
  standard: 691639,
  pro: 922358,
  krea: 2068000,
  ultra: 1088507,
} as const;

type FluxMode = 'draft' | 'standard' | 'pro' | 'krea' | 'ultra';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Determines the Flux mode from the model version ID.
 */
function getFluxMode(modelId?: number): FluxMode {
  if (!modelId) return 'standard';
  for (const [mode, id] of Object.entries(FLUX_VERSION_IDS)) {
    if (id === modelId) return mode as FluxMode;
  }
  return 'standard';
}

// =============================================================================
// Main Handler
// =============================================================================

/**
 * Creates step input for Flux family workflows.
 *
 * Different modes have different requirements:
 * - draft: Fast generation, no resources, fixed steps/cfg
 * - standard: Normal generation with resources
 * - krea: Similar to standard
 * - pro: No user resources, uses pro model
 * - ultra: Special aspect ratios, raw mode option
 */
export const createFluxInput = defineHandler<
  FluxCtx,
  (TextToImageStepTemplate | ImageGenStepTemplate | PreprocessImageStepTemplate)[]
>((data, ctx) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for Flux workflows');

  const modelId = data.model?.id;
  const fluxMode = data.fluxMode ?? getFluxMode(modelId);

  // Auto-generate seed if not provided
  const quantity = data.quantity ?? 1;
  const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

  // Get steps and cfg based on mode
  let steps = ('steps' in data ? data.steps : undefined) ?? 28;
  let cfgScale = ('cfgScale' in data ? data.cfgScale : undefined) ?? 3.5;

  // Handle draft mode overrides
  if (fluxMode === 'draft') {
    steps = 4;
    cfgScale = 1;
  }

  // Handle ultra mode - uses different step input structure
  if (fluxMode === 'ultra') {
    return [
      ctx.useImageGen ? createFluxUltraImageGen(data, seed) : createFluxUltraInput(data, seed),
    ];
  }

  // Build additionalNetworks from resources (not for pro mode)
  const resources = 'resources' in data ? data.resources : undefined;
  const additionalNetworks: Record<string, ImageJobNetworkParams> = {};
  if (fluxMode !== 'pro' && resources?.length) {
    for (const resource of resources) {
      additionalNetworks[ctx.airs.getOrThrow(resource.id)] = {
        strength: resource.strength,
      };
    }
  }

  // Get scheduler (Flux uses Euler by default)
  const scheduler = samplersToSchedulers['undefined'] as Scheduler;

  const { preprocessSteps, controlNets } = buildControlNetSteps(
    (data as { controlNets?: ControlNetsNodeValue }).controlNets,
    ctx.baseStepIndex
  );

  if (ctx.useImageGen) {
    if (fluxMode === 'pro') {
      const input: Flux1ProImageGenInput = {
        engine: 'flux1-pro',
        model: 'pro',
        prompt: data.prompt,
        width: data.aspectRatio.width,
        height: data.aspectRatio.height,
        seed,
        quantity,
        outputFormat: data.outputFormat,
      };
      return [
        ...preprocessSteps,
        { $type: 'imageGen', input: removeEmpty(input) } as ImageGenStepTemplate,
      ];
    }

    if (!data.model) throw new Error('Model is required for Flux imageGen workflows');

    const comfy = samplersToComfySamplers['undefined'];
    const input: ComfyFlux1CreateImageGenInput = {
      engine: 'comfy',
      ecosystem: 'flux1',
      operation: 'createImage',
      model: ctx.airs.getOrThrow(data.model.id),
      prompt: data.prompt,
      width: data.aspectRatio.width,
      height: data.aspectRatio.height,
      steps,
      cfgScale,
      sampler: comfy.sampler,
      scheduler: comfy.scheduler,
      seed,
      quantity,
      outputFormat: data.outputFormat,
      loras: Object.keys(additionalNetworks).length
        ? Object.fromEntries(
            Object.entries(additionalNetworks).map(([air, v]) => [air, v.strength ?? 1])
          )
        : undefined,
      ...(controlNets.length ? { controlNets } : {}),
    };

    return [
      ...preprocessSteps,
      { $type: 'imageGen', input: removeEmpty(input) } as ImageGenStepTemplate,
    ];
  }

  const genStep: TextToImageStepTemplate = {
    $type: 'textToImage',
    input: {
      model: data.model ? ctx.airs.getOrThrow(data.model.id) : undefined,
      additionalNetworks,
      scheduler,
      prompt: data.prompt,
      steps,
      cfgScale,
      seed,
      width: data.aspectRatio.width,
      height: data.aspectRatio.height,
      quantity,
      batchSize: 1,
      outputFormat: data.outputFormat,
      ...(controlNets.length ? { controlNets } : {}),
    },
  } as TextToImageStepTemplate;

  return [...preprocessSteps, genStep];
});

function createFluxUltraImageGen(data: FluxCtx, seed: number): ImageGenStepTemplate {
  const input: Flux1ProUltraImageGenInput = {
    engine: 'flux1-pro',
    model: 'ultra',
    prompt: data.prompt,
    aspectRatio: getClosestFluxUltraAspectRatioLabel(
      data.aspectRatio!.width,
      data.aspectRatio!.height
    ) as Flux1ProUltraImageGenInput['aspectRatio'],
    raw: 'fluxUltraRaw' in data ? (data.fluxUltraRaw as boolean) : false,
    seed,
    quantity: data.quantity ?? 1,
    outputFormat: data.outputFormat,
  };
  return { $type: 'imageGen', input: removeEmpty(input) };
}

/**
 * Creates step input for Flux Ultra mode.
 * Ultra mode uses special aspect ratios and has a raw mode option.
 */
function createFluxUltraInput(data: FluxCtx, seed: number): TextToImageStepTemplate {
  const fluxUltraRaw = 'fluxUltraRaw' in data ? data.fluxUltraRaw : false;
  // Get scheduler (Flux uses Euler by default)
  const scheduler = samplersToSchedulers['undefined'] as Scheduler;

  return {
    $type: 'textToImage',
    input: {
      model: fluxUltraAir,
      additionalNetworks: {},
      prompt: data.prompt,
      seed,
      width: data.aspectRatio!.width,
      height: data.aspectRatio!.height,
      quantity: data.quantity ?? 1,
      batchSize: 1,
      outputFormat: data.outputFormat,
      engine: fluxUltraRaw ? 'flux-pro-raw' : undefined,
      scheduler,
    },
  } as TextToImageStepTemplate;
}
