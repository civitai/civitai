/**
 * Flux Family Ecosystem Handler
 *
 * Handles Flux family workflows:
 * - Flux1, FluxKrea
 *
 * Uses textToImage step type for standard generation,
 * different handling for draft/pro/ultra modes.
 */

import type { ImageJobNetworkParams, Scheduler, WorkflowStepTemplate } from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import { fluxUltraAir, samplersToSchedulers } from '~/shared/constants/generation.constants';
import { getEcosystemName } from '~/shared/constants/basemodel.constants';
import { getRandomInt } from '~/utils/number-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type StepInput = WorkflowStepTemplate & { input: unknown };
type FluxCtx = EcosystemGraphOutput & {
  baseModel: 'Flux1' | 'FluxKrea';
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
 * Converts a ResourceData object to an AIR string.
 */
function resourceToAir(resource: ResourceData): string {
  const ecosystem = getEcosystemName(resource.baseModel);
  const type = resource.model.type.toLowerCase();
  return `urn:air:${ecosystem}:${type}:civitai:${resource.model.id}@${resource.id}`;
}

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
export async function createFluxInput(data: FluxCtx): Promise<StepInput> {
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
    return createFluxUltraInput(data, seed);
  }

  // Build additionalNetworks from resources (not for pro mode)
  const resources = 'resources' in data ? data.resources : undefined;
  const additionalNetworks: Record<string, ImageJobNetworkParams> = {};
  if (fluxMode !== 'pro' && resources?.length) {
    for (const resource of resources) {
      additionalNetworks[resourceToAir(resource)] = {
        strength: resource.strength,
        type: resource.model.type,
      };
    }
  }

  // Get scheduler (Flux uses Euler by default)
  const scheduler = samplersToSchedulers['Euler'] as Scheduler;

  return {
    $type: 'textToImage',
    input: {
      model: data.model ? resourceToAir(data.model) : undefined,
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
    },
  } as StepInput;
}

/**
 * Creates step input for Flux Ultra mode.
 * Ultra mode uses special aspect ratios and has a raw mode option.
 */
function createFluxUltraInput(data: FluxCtx, seed: number): StepInput {
  const fluxUltraRaw = 'fluxUltraRaw' in data ? data.fluxUltraRaw : false;

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
    },
  } as StepInput;
}
