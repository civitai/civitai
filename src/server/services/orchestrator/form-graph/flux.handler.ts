/**
 * Flux family handler for the form-graph lane (Flux1 + FluxKrea) —
 * textToImage steps; draft pins steps/cfg, pro drops resources, ultra routes
 * to the fixed ultra AIR with its raw-mode engine switch.
 */

import type {
  ImageJobNetworkParams,
  PreprocessImageStepTemplate,
  Scheduler,
  TextToImageStepTemplate,
} from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import { fluxUltraAir, samplersToSchedulers } from '~/shared/constants/generation.constants';
import { getRandomInt } from '~/utils/number-helpers';
import { defineHandler } from '../ecosystems/handler-factory';
import { buildControlNetSteps } from '../ecosystems/controlnets.helper';
import type { EcosystemData } from './types';

type FluxData = EcosystemData<'Flux1' | 'FluxKrea'>;

export const createFluxInput = defineHandler<
  FluxData,
  (TextToImageStepTemplate | PreprocessImageStepTemplate)[]
>((data, ctx) => {
  if (!data.aspectRatio) throw new Error('Aspect ratio is required for Flux workflows');

  const quantity = data.quantity ?? 1;
  const seed = data.seed ?? getRandomInt(quantity, maxRandomSeed) - quantity;

  if (data.fluxMode === 'ultra') {
    return [createFluxUltraInput(data, seed)];
  }

  let steps = ('steps' in data ? data.steps : undefined) ?? 28;
  let cfgScale = ('cfgScale' in data ? data.cfgScale : undefined) ?? 3.5;

  if (data.fluxMode === 'draft') {
    steps = 4;
    cfgScale = 1;
  }

  const additionalNetworks: Record<string, ImageJobNetworkParams> = {};
  if (data.fluxMode !== 'pro' && 'resources' in data && data.resources?.length) {
    for (const resource of data.resources) {
      additionalNetworks[ctx.airs.getOrThrow(resource.id)] = { strength: resource.strength };
    }
  }

  // v1 parity: send Scheduler.UNDEFINED (the 'undefined' map entry) and let
  // the orchestrator default the sampler
  const scheduler = samplersToSchedulers[
    'undefined' as keyof typeof samplersToSchedulers
  ] as Scheduler;

  const { preprocessSteps, controlNets } = buildControlNetSteps(
    'controlNets' in data ? data.controlNets : undefined,
    ctx.baseStepIndex
  );

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

/** Ultra mode: fixed ultra AIR, special aspect ratios, raw-mode engine switch. */
function createFluxUltraInput(
  data: Extract<FluxData, { fluxMode: 'ultra' }>,
  seed: number
): TextToImageStepTemplate {
  const scheduler = samplersToSchedulers[
    'undefined' as keyof typeof samplersToSchedulers
  ] as Scheduler;
  return {
    $type: 'textToImage',
    input: {
      model: fluxUltraAir,
      additionalNetworks: {},
      prompt: data.prompt,
      seed,
      width: data.aspectRatio.width,
      height: data.aspectRatio.height,
      quantity: data.quantity ?? 1,
      batchSize: 1,
      outputFormat: data.outputFormat,
      engine: data.fluxUltraRaw ? 'flux-pro-raw' : undefined,
      scheduler,
    },
  } as TextToImageStepTemplate;
}
