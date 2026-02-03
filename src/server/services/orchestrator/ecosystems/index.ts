/**
 * Ecosystem Handlers Index
 *
 * Central export point for all ecosystem step input creators.
 * Each ecosystem handler converts generation-graph output into
 * the appropriate orchestrator step input format.
 *
 * Handler files follow the {name}.handler.ts naming convention:
 * - stable-diffusion.handler.ts → stable-diffusion-graph.ts (SD1, SD2, SDXL, Pony, Illustrious, NoobAI)
 * - flux.handler.ts → flux-graph.ts (Flux1, FluxKrea)
 * - flux2.handler.ts → flux2-graph.ts
 * - flux-kontext.handler.ts → flux-kontext-graph.ts
 * - etc.
 */

import type {
  ComfyStepTemplate,
  ImageGenStepTemplate,
  TextToImageStepTemplate,
  VideoGenStepTemplate,
} from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { GenerationHandlerCtx } from '../orchestration-new.service';

// Image ecosystem handlers
import { createStableDiffusionInput } from './stable-diffusion.handler';
import { createFluxInput } from './flux.handler';
import { createFlux2Input } from './flux2.handler';
import { createFlux2KleinInput } from './flux2-klein.handler';
import { createFluxKontextInput } from './flux-kontext.handler';
import { createQwenInput } from './qwen.handler';
import { createSeedreamInput } from './seedream.handler';
import { createImagen4Input } from './imagen4.handler';
import { createOpenAIInput } from './openai.handler';
import { createNanoBananaInput } from './nano-banana.handler';
import { createChromaInput } from './chroma.handler';
import { createZImageInput } from './z-image.handler';
import { createHiDreamInput } from './hi-dream.handler';
import { createPonyV7Input } from './pony-v7.handler';

// Video ecosystem handlers
import { createWanInput } from './wan.handler';
import { createViduInput } from './vidu.handler';
import { createKlingInput } from './kling.handler';
import { createHunyuanInput } from './hunyuan.handler';
import { createLTXV2Input } from './ltxv2.handler';
import { createMochiInput } from './mochi.handler';
import { createSoraInput } from './sora.handler';
import { createVeo3Input } from './veo3.handler';

// =============================================================================
// Types - Derived from GenerationGraph
// =============================================================================

/** Step input for orchestrator - union of all possible step types */
export type StepInput =
  | TextToImageStepTemplate
  | ComfyStepTemplate
  | ImageGenStepTemplate
  | VideoGenStepTemplate;

/** Validated output from the generation graph with baseModel */
export type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;

/** SD family context */
export type SDFamilyCtx = EcosystemGraphOutput & {
  baseModel: 'SD1' | 'SD2' | 'SDXL' | 'Pony' | 'Illustrious' | 'NoobAI';
};

/** Flux family context (Flux1/FluxKrea - textToImage) */
export type FluxCtx = EcosystemGraphOutput & {
  baseModel: 'Flux1' | 'FluxKrea';
};

/** Flux2 context */
export type Flux2Ctx = EcosystemGraphOutput & { baseModel: 'Flux2' };

/** Flux2 Klein context */
export type Flux2KleinCtx = EcosystemGraphOutput & {
  baseModel: 'Flux2Klein_9B' | 'Flux2Klein_9B_base' | 'Flux2Klein_4B' | 'Flux2Klein_4B_base';
};

/** Flux Kontext context */
export type FluxKontextCtx = EcosystemGraphOutput & { baseModel: 'Flux1Kontext' };

/** Qwen context */
export type QwenCtx = EcosystemGraphOutput & { baseModel: 'Qwen' };

/** Seedream context */
export type SeedreamCtx = EcosystemGraphOutput & { baseModel: 'Seedream' };

/** Imagen4 context */
export type Imagen4Ctx = EcosystemGraphOutput & { baseModel: 'Imagen4' };

/** OpenAI context */
export type OpenAICtx = EcosystemGraphOutput & { baseModel: 'OpenAI' };

/** NanoBanana context */
export type NanoBananaCtx = EcosystemGraphOutput & { baseModel: 'NanoBanana' };

/** Chroma context */
export type ChromaCtx = EcosystemGraphOutput & { baseModel: 'Chroma' };

/** ZImage context (ZImageTurbo and ZImageBase) */
export type ZImageCtx = EcosystemGraphOutput & { baseModel: 'ZImageTurbo' | 'ZImageBase' };

/** HiDream context */
export type HiDreamCtx = EcosystemGraphOutput & { baseModel: 'HiDream' };

/** PonyV7 context */
export type PonyV7Ctx = EcosystemGraphOutput & { baseModel: 'PonyV7' };

/** Wan video ecosystems context */
export type WanCtx = EcosystemGraphOutput & {
  baseModel:
    | 'WanVideo'
    | 'WanVideo1_3B_T2V'
    | 'WanVideo14B_T2V'
    | 'WanVideo14B_I2V_480p'
    | 'WanVideo14B_I2V_720p'
    | 'WanVideo-22-TI2V-5B'
    | 'WanVideo-22-I2V-A14B'
    | 'WanVideo-22-T2V-A14B'
    | 'WanVideo-25-T2V'
    | 'WanVideo-25-I2V';
};

/** Vidu context */
export type ViduCtx = EcosystemGraphOutput & { baseModel: 'Vidu' };

/** Kling context */
export type KlingCtx = EcosystemGraphOutput & { baseModel: 'Kling' };

/** Hunyuan (HyV1) context */
export type HunyuanCtx = EcosystemGraphOutput & { baseModel: 'HyV1' };

/** LTXV2 context */
export type LTXV2Ctx = EcosystemGraphOutput & { baseModel: 'LTXV2' };

/** Mochi context */
export type MochiCtx = EcosystemGraphOutput & { baseModel: 'Mochi' };

/** Sora2 context */
export type SoraCtx = EcosystemGraphOutput & { baseModel: 'Sora2' };

/** Veo3 context */
export type Veo3Ctx = EcosystemGraphOutput & { baseModel: 'Veo3' };

// =============================================================================
// Exports - Individual handlers
// =============================================================================

// Image ecosystems
export { createStableDiffusionInput } from './stable-diffusion.handler';
export { createFluxInput } from './flux.handler';
export { createFlux2Input } from './flux2.handler';
export { createFlux2KleinInput } from './flux2-klein.handler';
export { createFluxKontextInput } from './flux-kontext.handler';
export { createQwenInput } from './qwen.handler';
export { createSeedreamInput } from './seedream.handler';
export { createImagen4Input } from './imagen4.handler';
export { createOpenAIInput } from './openai.handler';
export { createNanoBananaInput } from './nano-banana.handler';
export { createChromaInput } from './chroma.handler';
export { createZImageInput } from './z-image.handler';
export { createHiDreamInput } from './hi-dream.handler';
export { createPonyV7Input } from './pony-v7.handler';

// Video ecosystems
export { createWanInput } from './wan.handler';
export { createViduInput } from './vidu.handler';
export { createKlingInput } from './kling.handler';
export { createHunyuanInput } from './hunyuan.handler';
export { createLTXV2Input } from './ltxv2.handler';
export { createMochiInput } from './mochi.handler';
export { createSoraInput } from './sora.handler';
export { createVeo3Input } from './veo3.handler';

// Shared utilities
export { createComfyInput } from './comfy-input';

// =============================================================================
// Unified Router
// =============================================================================

// Re-export GenerationHandlerCtx for handlers
export type { GenerationHandlerCtx } from '../orchestration-new.service';

/**
 * Creates step input for any ecosystem.
 * Routes to the appropriate handler based on baseModel.
 * Normalizes seed value before passing to handlers.
 *
 * @param data - Validated ecosystem graph output
 * @param handlerCtx - Context with pre-computed AIR strings for resource lookup
 */
export async function createEcosystemStepInput(
  data: EcosystemGraphOutput,
  handlerCtx: GenerationHandlerCtx
): Promise<StepInput> {
  // Normalize seed - generate random if not provided
  const normalizedData = {
    ...data,
    seed: data.seed ?? Math.floor(Math.random() * maxRandomSeed),
  };
  const { baseModel } = normalizedData;

  switch (baseModel) {
    // =========================================================================
    // Image Ecosystems - textToImage step type
    // =========================================================================

    // SD Family
    case 'SD1':
    case 'SD2':
    case 'SDXL':
    case 'Pony':
    case 'Illustrious':
    case 'NoobAI':
      return createStableDiffusionInput(normalizedData, handlerCtx);

    // Flux Family
    case 'Flux1':
    case 'FluxKrea':
      return createFluxInput(normalizedData, handlerCtx);

    // Chroma
    case 'Chroma':
      return createChromaInput(normalizedData, handlerCtx);

    // ZImage Family
    case 'ZImageTurbo':
    case 'ZImageBase':
      return { $type: 'imageGen', input: await createZImageInput(normalizedData, handlerCtx) };

    // HiDream
    case 'HiDream':
      return createHiDreamInput(normalizedData, handlerCtx);

    // PonyV7
    case 'PonyV7':
      return createPonyV7Input(normalizedData, handlerCtx);

    // =========================================================================
    // Image Ecosystems - imageGen step type
    // =========================================================================

    // Flux2
    case 'Flux2':
      return { $type: 'imageGen', input: await createFlux2Input(normalizedData, handlerCtx) };

    // Flux2 Klein Family
    case 'Flux2Klein_9B':
    case 'Flux2Klein_9B_base':
    case 'Flux2Klein_4B':
    case 'Flux2Klein_4B_base':
      return { $type: 'imageGen', input: await createFlux2KleinInput(normalizedData, handlerCtx) };

    // Flux Kontext
    case 'Flux1Kontext':
      return { $type: 'imageGen', input: await createFluxKontextInput(normalizedData, handlerCtx) };

    // Qwen
    case 'Qwen':
      return { $type: 'imageGen', input: await createQwenInput(normalizedData, handlerCtx) };

    // Seedream
    case 'Seedream':
      return { $type: 'imageGen', input: await createSeedreamInput(normalizedData, handlerCtx) };

    // Imagen4
    case 'Imagen4':
      return { $type: 'imageGen', input: await createImagen4Input(normalizedData, handlerCtx) };

    // OpenAI
    case 'OpenAI':
      return { $type: 'imageGen', input: await createOpenAIInput(normalizedData, handlerCtx) };

    // NanoBanana
    case 'NanoBanana':
      return { $type: 'imageGen', input: await createNanoBananaInput(normalizedData, handlerCtx) };

    // =========================================================================
    // Video Ecosystems - videoGen step type
    // =========================================================================

    // Wan family
    case 'WanVideo14B_T2V':
    case 'WanVideo14B_I2V_480p':
    case 'WanVideo14B_I2V_720p':
    case 'WanVideo-22-TI2V-5B':
    case 'WanVideo-22-I2V-A14B':
    case 'WanVideo-22-T2V-A14B':
    case 'WanVideo-25-T2V':
    case 'WanVideo-25-I2V':
      return { $type: 'videoGen', input: await createWanInput(normalizedData, handlerCtx) };

    // Vidu
    case 'Vidu':
      return { $type: 'videoGen', input: await createViduInput(normalizedData, handlerCtx) };

    // Kling
    case 'Kling':
      return { $type: 'videoGen', input: await createKlingInput(normalizedData, handlerCtx) };

    // Hunyuan (HyV1)
    case 'HyV1':
      return { $type: 'videoGen', input: await createHunyuanInput(normalizedData, handlerCtx) };

    // LTXV2
    case 'LTXV2':
      return { $type: 'videoGen', input: await createLTXV2Input(normalizedData, handlerCtx) };

    // Mochi
    case 'Mochi':
      return { $type: 'videoGen', input: await createMochiInput(normalizedData, handlerCtx) };

    // Sora2
    case 'Sora2':
      return { $type: 'videoGen', input: await createSoraInput(normalizedData, handlerCtx) };

    // Veo3
    case 'Veo3':
      return { $type: 'videoGen', input: await createVeo3Input(normalizedData, handlerCtx) };

    default:
      throw new Error(`Unknown ecosystem: ${baseModel}`);
  }
}
