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

import type { WorkflowStepTemplate } from '@civitai/client';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';

// Image ecosystem handlers
import { createStableDiffusionInput } from './stable-diffusion.handler';
import { createFluxInput } from './flux.handler';
import { createFlux2Input } from './flux2.handler';
import { createFluxKontextInput } from './flux-kontext.handler';
import { createQwenInput } from './qwen.handler';
import { createSeedreamInput } from './seedream.handler';
import { createImagen4Input } from './imagen4.handler';
import { createOpenAIInput } from './openai.handler';
import { createNanoBananaInput } from './nano-banana.handler';
import { createChromaInput } from './chroma.handler';
import { createZImageTurboInput } from './z-image-turbo.handler';
import { createHiDreamInput } from './hi-dream.handler';
import { createPonyV7Input } from './pony-v7.handler';

// Video ecosystem handlers
import { createWanInput } from './wan.handler';
import { createViduInput } from './vidu.handler';
import { createKlingInput } from './kling.handler';
import { createHunyuanInput } from './hunyuan.handler';
import { createMiniMaxInput } from './minimax.handler';
import { createMochiInput } from './mochi.handler';
import { createSoraInput } from './sora.handler';
import { createVeo3Input } from './veo3.handler';

// =============================================================================
// Types - Derived from GenerationGraph
// =============================================================================

/** Step input for orchestrator */
export type StepInput = WorkflowStepTemplate & { input: unknown };

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

/** ZImageTurbo context */
export type ZImageTurboCtx = EcosystemGraphOutput & { baseModel: 'ZImageTurbo' };

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
    | 'WanVideo22_TI2V_5B'
    | 'WanVideo22_I2V_A14B'
    | 'WanVideo22_T2V_A14B'
    | 'WanVideo25_T2V'
    | 'WanVideo25_I2V';
};

/** Vidu context */
export type ViduCtx = EcosystemGraphOutput & { baseModel: 'Vidu' };

/** Kling context */
export type KlingCtx = EcosystemGraphOutput & { baseModel: 'Kling' };

/** Hunyuan (HyV1) context */
export type HunyuanCtx = EcosystemGraphOutput & { baseModel: 'HyV1' };

/** MiniMax context */
export type MiniMaxCtx = EcosystemGraphOutput & { baseModel: 'MiniMax' };

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
export { createFluxKontextInput } from './flux-kontext.handler';
export { createQwenInput } from './qwen.handler';
export { createSeedreamInput } from './seedream.handler';
export { createImagen4Input } from './imagen4.handler';
export { createOpenAIInput } from './openai.handler';
export { createNanoBananaInput } from './nano-banana.handler';
export { createChromaInput } from './chroma.handler';
export { createZImageTurboInput } from './z-image-turbo.handler';
export { createHiDreamInput } from './hi-dream.handler';
export { createPonyV7Input } from './pony-v7.handler';

// Video ecosystems
export { createWanInput } from './wan.handler';
export { createViduInput } from './vidu.handler';
export { createKlingInput } from './kling.handler';
export { createHunyuanInput } from './hunyuan.handler';
export { createMiniMaxInput } from './minimax.handler';
export { createMochiInput } from './mochi.handler';
export { createSoraInput } from './sora.handler';
export { createVeo3Input } from './veo3.handler';

// =============================================================================
// Unified Router
// =============================================================================

/**
 * Creates step input for any ecosystem.
 * Routes to the appropriate handler based on baseModel.
 */
export async function createEcosystemStepInput(data: EcosystemGraphOutput): Promise<StepInput> {
  const { baseModel } = data;

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
      return createStableDiffusionInput(data as SDFamilyCtx);

    // Flux Family
    case 'Flux1':
    case 'FluxKrea':
      return createFluxInput(data as FluxCtx);

    // Chroma
    case 'Chroma':
      return createChromaInput(data as ChromaCtx);

    // ZImageTurbo
    case 'ZImageTurbo':
      return createZImageTurboInput(data as ZImageTurboCtx);

    // HiDream
    case 'HiDream':
      return createHiDreamInput(data as HiDreamCtx);

    // PonyV7
    case 'PonyV7':
      return createPonyV7Input(data as PonyV7Ctx);

    // =========================================================================
    // Image Ecosystems - imageGen step type
    // =========================================================================

    // Flux2
    case 'Flux2':
      return { $type: 'imageGen', input: await createFlux2Input(data as Flux2Ctx) };

    // Flux Kontext
    case 'Flux1Kontext':
      return { $type: 'imageGen', input: await createFluxKontextInput(data as FluxKontextCtx) };

    // Qwen
    case 'Qwen':
      return { $type: 'imageGen', input: await createQwenInput(data as QwenCtx) };

    // Seedream
    case 'Seedream':
      return { $type: 'imageGen', input: await createSeedreamInput(data as SeedreamCtx) };

    // Imagen4
    case 'Imagen4':
      return { $type: 'imageGen', input: await createImagen4Input(data as Imagen4Ctx) };

    // OpenAI
    case 'OpenAI':
      return { $type: 'imageGen', input: await createOpenAIInput(data as OpenAICtx) };

    // NanoBanana
    case 'NanoBanana':
      return { $type: 'imageGen', input: await createNanoBananaInput(data as NanoBananaCtx) };

    // =========================================================================
    // Video Ecosystems - videoGen step type
    // =========================================================================

    // Wan family
    case 'WanVideo14B_T2V':
    case 'WanVideo14B_I2V_480p':
    case 'WanVideo14B_I2V_720p':
    case 'WanVideo22_TI2V_5B':
    case 'WanVideo22_I2V_A14B':
    case 'WanVideo22_T2V_A14B':
    case 'WanVideo25_T2V':
    case 'WanVideo25_I2V':
      return { $type: 'videoGen', input: await createWanInput(data as WanCtx) };

    // Vidu
    case 'Vidu':
      return { $type: 'videoGen', input: await createViduInput(data as ViduCtx) };

    // Kling
    case 'Kling':
      return { $type: 'videoGen', input: await createKlingInput(data as KlingCtx) };

    // Hunyuan (HyV1)
    case 'HyV1':
      return { $type: 'videoGen', input: await createHunyuanInput(data as HunyuanCtx) };

    // MiniMax
    case 'MiniMax':
      return { $type: 'videoGen', input: await createMiniMaxInput(data as MiniMaxCtx) };

    // Mochi
    case 'Mochi':
      return { $type: 'videoGen', input: await createMochiInput(data as MochiCtx) };

    // Sora2
    case 'Sora2':
      return { $type: 'videoGen', input: await createSoraInput(data as SoraCtx) };

    // Veo3
    case 'Veo3':
      return { $type: 'videoGen', input: await createVeo3Input(data as Veo3Ctx) };

    default:
      throw new Error(`Unknown ecosystem: ${baseModel}`);
  }
}
