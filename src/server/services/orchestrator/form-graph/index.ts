/**
 * Step-input router for the form-graph lane: `generationHub.parse().data` in,
 * @civitai/client steps out. Mirrors the data-graph dispatcher
 * (`../ecosystems/index.ts`) for the ported families; an unported ecosystem is
 * a loud error rather than a silent fallthrough, because reaching here with
 * one means the caller routed a family this lane cannot serve yet.
 *
 * `data.ecosystem` is the WIRE value — for wan that is the derived backend
 * key, which is exactly what the version lookup wants.
 */

import { maxRandomSeed } from '~/server/common/constants';
import { EXPERIMENTAL_MODE_SUPPORTED_MODELS } from '~/shared/constants/generation.constants';
import { isWanEcosystem } from '~/shared/form-graph/generation/video/wan.graph';
import type { GenerationHandlerCtx, StepInput } from '../ecosystems';
import { createChromaInput } from './chroma.handler';
import { createLTXInput } from './ltx.handler';
import { createSeedanceInput } from './seedance.handler';
import { createStableDiffusionInput } from './stable-diffusion.handler';
import { createWanSteps } from './wan.handler';
import { createZImageInput } from './z-image.handler';
import type { GenerationData, LooseGenerationData } from './types';

export type { GenerationData, LooseGenerationData } from './types';
export { createChromaInput } from './chroma.handler';
export { createLTXInput } from './ltx.handler';
export { createSeedanceInput } from './seedance.handler';
export { createStableDiffusionInput } from './stable-diffusion.handler';
export { createWanSteps } from './wan.handler';
export { createZImageInput } from './z-image.handler';

export async function createFormGraphStepInput(
  data: GenerationData,
  handlerCtx: GenerationHandlerCtx
): Promise<StepInput[]> {
  const loose = data as LooseGenerationData;
  const normalizedData: LooseGenerationData = {
    ...loose,
    seed: loose.seed ?? Math.floor(Math.random() * maxRandomSeed),
  };

  const steps = await createStep(normalizedData, handlerCtx);

  // Enhanced compatibility mode: comfyui engine for every textToImage step.
  if (
    loose.enhancedCompatibility &&
    EXPERIMENTAL_MODE_SUPPORTED_MODELS.includes(loose.ecosystem ?? '')
  ) {
    for (const step of steps) {
      if (step.$type === 'textToImage') {
        (step as { input: Record<string, unknown> }).input.engine = 'comfyui';
      }
    }
  }

  return steps;
}

function createStep(
  data: LooseGenerationData,
  handlerCtx: GenerationHandlerCtx
): Promise<StepInput[]> | StepInput[] {
  const ecosystem = data.ecosystem ?? '';

  if (isWanEcosystem(ecosystem)) return createWanSteps(data, handlerCtx);

  switch (ecosystem) {
    case 'SD1':
    case 'SD2':
    case 'SDXL':
    case 'Pony':
    case 'Illustrious':
    case 'NoobAI':
      return createStableDiffusionInput(data, handlerCtx);

    case 'ZImageTurbo':
    case 'ZImageBase':
      return createZImageInput(data, handlerCtx);

    case 'Chroma':
      return createChromaInput(data, handlerCtx);

    case 'LTXV2':
    case 'LTXV23':
    case 'LTXV25':
      return createLTXInput(data, handlerCtx);

    case 'Seedance':
      return createSeedanceInput(data, handlerCtx);

    default:
      throw new Error(`form-graph lane has no handler for ecosystem "${ecosystem}"`);
  }
}
