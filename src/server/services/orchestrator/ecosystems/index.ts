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
  AceStepAudioStepTemplate,
  ChatCompletionStepTemplate,
  ComfyStepTemplate,
  ImageGenStepTemplate,
  PreprocessImageStepTemplate,
  PromptEnhancementStepTemplate,
  TextToImageStepTemplate,
  VideoGenStepTemplate,
  VideoInterpolationStepTemplate,
} from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import { EXPERIMENTAL_MODE_SUPPORTED_MODELS } from '~/shared/constants/generation.constants';
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
import { createAnimaInput } from './anima.handler';
import { createChromaInput } from './chroma.handler';
import { createErnieInput } from './ernie.handler';
import { createLensInput } from './lens.handler';
import { createKrea2Input } from './krea2.handler';
import { createMAIInput } from './mai.handler';
import { createZImageInput } from './z-image.handler';
import { createBooguInput } from './boogu.handler';
import { createHiDreamInput } from './hi-dream.handler';
import { createHiDreamO1Input } from './hi-dream-o1.handler';
import { createPonyV7Input } from './pony-v7.handler';

// Audio ecosystem handlers
import { createAceAudioInput } from './ace-audio.handler';

// 3D model ecosystem handlers
import { createPolyGenInput } from './polygen-graph.handler';

// Video ecosystem handlers
import { createWanSteps } from './wan.handler';
import { createViduInput } from './vidu.handler';
import { createKlingInput } from './kling.handler';
import { createHunyuanInput } from './hunyuan.handler';
import { createLTXInput } from './ltx.handler';
import { createMochiInput } from './mochi.handler';
import { createSoraInput } from './sora.handler';
import { createVeo3Input } from './veo3.handler';
import { createGrokImageInput, createGrokVideoInput } from './grok.handler';
import { createSeedanceInput } from './seedance.handler';
import { createHappyHorseInput } from './happy-horse.handler';

// =============================================================================
// Types - Derived from GenerationGraph
// =============================================================================

/** Step input for orchestrator - union of all possible step types */
export type StepInput =
  | TextToImageStepTemplate
  | ComfyStepTemplate
  | ImageGenStepTemplate
  | VideoGenStepTemplate
  | VideoInterpolationStepTemplate
  | AceStepAudioStepTemplate
  | ChatCompletionStepTemplate
  | PromptEnhancementStepTemplate
  | PreprocessImageStepTemplate;

/** Validated output from the generation graph with ecosystem */
export type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;

/** SD family context */
export type SDFamilyCtx = EcosystemGraphOutput & {
  ecosystem: 'SD1' | 'SD2' | 'SDXL' | 'Pony' | 'Illustrious' | 'NoobAI';
};

/** Flux family context (Flux1/FluxKrea - textToImage) */
export type FluxCtx = EcosystemGraphOutput & {
  ecosystem: 'Flux1' | 'FluxKrea';
};

/** Flux2 context */
export type Flux2Ctx = EcosystemGraphOutput & { ecosystem: 'Flux2' };

/** Flux2 Klein context */
export type Flux2KleinCtx = EcosystemGraphOutput & {
  ecosystem: 'Flux2Klein_9B' | 'Flux2Klein_9B_base' | 'Flux2Klein_4B' | 'Flux2Klein_4B_base';
};

/** Flux Kontext context */
export type FluxKontextCtx = EcosystemGraphOutput & { ecosystem: 'Flux1Kontext' };

/** Qwen context */
export type QwenCtx = EcosystemGraphOutput & { ecosystem: 'Qwen' };

/** Seedream context */
export type SeedreamCtx = EcosystemGraphOutput & { ecosystem: 'Seedream' };

/** Imagen4 context */
export type Imagen4Ctx = EcosystemGraphOutput & { ecosystem: 'Imagen4' };

/** OpenAI context */
export type OpenAICtx = EcosystemGraphOutput & { ecosystem: 'OpenAI' };

/** NanoBanana context */
export type NanoBananaCtx = EcosystemGraphOutput & { ecosystem: 'NanoBanana' };

/** Chroma context */
export type ChromaCtx = EcosystemGraphOutput & { ecosystem: 'Chroma' };

/** ZImage context (ZImageTurbo and ZImageBase) */
export type ZImageCtx = EcosystemGraphOutput & { ecosystem: 'ZImageTurbo' | 'ZImageBase' };

/** Boogu context */
export type BooguCtx = EcosystemGraphOutput & { ecosystem: 'Boogu' };

/** HiDream context */
export type HiDreamCtx = EcosystemGraphOutput & { ecosystem: 'HiDream' };

/** HiDream-O1 context */
export type HiDreamO1Ctx = EcosystemGraphOutput & { ecosystem: 'HiDream-O1' };

/** Anima context */
export type AnimaCtx = EcosystemGraphOutput & { ecosystem: 'Anima' };

/** PonyV7 context */
export type PonyV7Ctx = EcosystemGraphOutput & { ecosystem: 'PonyV7' };

/** Ernie context */
export type ErnieCtx = EcosystemGraphOutput & { ecosystem: 'Ernie' };

/** Lens context */
export type LensCtx = EcosystemGraphOutput & { ecosystem: 'Lens' };

/** Krea 2 context */
export type Krea2Ctx = EcosystemGraphOutput & { ecosystem: 'Krea2' };

/** MAI context */
export type MAICtx = EcosystemGraphOutput & { ecosystem: 'MAI' };

/** Wan video ecosystems context */
export type WanCtx = EcosystemGraphOutput & {
  ecosystem:
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
export type ViduCtx = EcosystemGraphOutput & { ecosystem: 'Vidu' };

/** Kling context */
export type KlingCtx = EcosystemGraphOutput & { ecosystem: 'Kling' };

/** Hunyuan (HyV1) context */
export type HunyuanCtx = EcosystemGraphOutput & { ecosystem: 'HyV1' };

/** LTX (LTXV2 + LTXV23) context */
export type LTXCtx = EcosystemGraphOutput & { ecosystem: 'LTXV2' | 'LTXV23' };

/** Mochi context */
export type MochiCtx = EcosystemGraphOutput & { ecosystem: 'Mochi' };

/** Sora2 context */
export type SoraCtx = EcosystemGraphOutput & { ecosystem: 'Sora2' };

/** Veo3 context */
export type Veo3Ctx = EcosystemGraphOutput & { ecosystem: 'Veo3' };

/** Grok context */
export type GrokCtx = EcosystemGraphOutput & { ecosystem: 'Grok' };

/** Seedance context */
export type SeedanceCtx = EcosystemGraphOutput & { ecosystem: 'Seedance' };

/** HappyHorse context */
export type HappyHorseCtx = EcosystemGraphOutput & { ecosystem: 'HappyHorse' };

/** AceAudio context */
export type AceAudioCtx = EcosystemGraphOutput & { ecosystem: 'Ace' };

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
export { createAnimaInput } from './anima.handler';
export { createChromaInput } from './chroma.handler';
export { createZImageInput } from './z-image.handler';
export { createBooguInput } from './boogu.handler';
export { createHiDreamInput } from './hi-dream.handler';
export { createHiDreamO1Input } from './hi-dream-o1.handler';
export { createPonyV7Input } from './pony-v7.handler';
export { createErnieInput } from './ernie.handler';
export { createLensInput } from './lens.handler';
export { createKrea2Input } from './krea2.handler';
export { createMAIInput } from './mai.handler';

// Audio ecosystems
export { createAceAudioInput } from './ace-audio.handler';

// 3D model ecosystems
export { createPolyGenInput } from './polygen-graph.handler';

// Video ecosystems
export { createWanSteps } from './wan.handler';
export { createViduInput } from './vidu.handler';
export { createKlingInput } from './kling.handler';
export { createHunyuanInput } from './hunyuan.handler';
export { createLTXInput } from './ltx.handler';
export { createMochiInput } from './mochi.handler';
export { createSoraInput } from './sora.handler';
export { createVeo3Input } from './veo3.handler';
export { createGrokImageInput, createGrokVideoInput } from './grok.handler';
export { createSeedanceInput } from './seedance.handler';
export { createHappyHorseInput } from './happy-horse.handler';

// Shared utilities
export { createComfyInput } from './comfy-input';

// =============================================================================
// Unified Router
// =============================================================================

// Re-export GenerationHandlerCtx for handlers
export type { GenerationHandlerCtx } from '../orchestration-new.service';

/**
 * Creates step input for any ecosystem.
 * Routes to the appropriate handler based on ecosystem.
 * Normalizes seed value before passing to handlers.
 *
 * @param data - Validated ecosystem graph output
 * @param handlerCtx - Context with pre-computed AIR strings for resource lookup
 */
export async function createEcosystemStepInput(
  data: EcosystemGraphOutput,
  handlerCtx: GenerationHandlerCtx
): Promise<StepInput[]> {
  // Normalize seed - generate random if not provided.
  // Some ecosystems (e.g. PolyGen / 3D models) don't expose a `seed` node and
  // route their submission outside this dispatcher entirely, so the field is
  // absent from their graph branch — read defensively.
  const dataSeed = 'seed' in data ? (data as { seed?: number }).seed : undefined;
  const normalizedData = {
    ...data,
    seed: dataSeed ?? Math.floor(Math.random() * maxRandomSeed),
  };

  const steps = await createEcosystemStep(normalizedData, handlerCtx);

  // Enhanced compatibility mode: set engine to 'comfyui' for every textToImage step
  // in EXPERIMENTAL_MODE_SUPPORTED_MODELS ecosystems.
  if (
    'enhancedCompatibility' in data &&
    data.enhancedCompatibility &&
    // Belt-and-suspenders check in case data.ecosystem leaks an unsupported ecosystem through a non-UI path
    EXPERIMENTAL_MODE_SUPPORTED_MODELS.includes(data.ecosystem)
  ) {
    for (const step of steps) {
      if (step.$type === 'textToImage') {
        (step as { input: Record<string, unknown> }).input.engine = 'comfyui';
      }
    }
  }

  return steps;
}

async function createEcosystemStep(
  normalizedData: EcosystemGraphOutput & { seed: number },
  handlerCtx: GenerationHandlerCtx
): Promise<StepInput[]> {
  const { ecosystem } = normalizedData;

  switch (ecosystem) {
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

    // Anima
    case 'Anima':
      return createAnimaInput(normalizedData, handlerCtx);

    // Chroma
    case 'Chroma':
      return createChromaInput(normalizedData, handlerCtx);

    // ZImage Family
    case 'ZImageTurbo':
    case 'ZImageBase':
      return createZImageInput(normalizedData, handlerCtx);

    // Boogu
    case 'Boogu':
      return createBooguInput(normalizedData, handlerCtx);

    // HiDream
    case 'HiDream':
      return createHiDreamInput(normalizedData, handlerCtx);

    // HiDream-O1
    case 'HiDream-O1':
      return createHiDreamO1Input(normalizedData, handlerCtx);

    // PonyV7
    case 'PonyV7':
      return createPonyV7Input(normalizedData, handlerCtx);

    // =========================================================================
    // Image Ecosystems - imageGen step type
    // =========================================================================

    // Flux2
    case 'Flux2':
      return createFlux2Input(normalizedData, handlerCtx);

    // Flux2 Klein Family
    case 'Flux2Klein_9B':
    case 'Flux2Klein_9B_base':
    case 'Flux2Klein_4B':
    case 'Flux2Klein_4B_base':
      return createFlux2KleinInput(normalizedData, handlerCtx);

    // Flux Kontext
    case 'Flux1Kontext':
      return createFluxKontextInput(normalizedData, handlerCtx);

    // Qwen family
    case 'Qwen':
    case 'Qwen2':
      return createQwenInput(normalizedData, handlerCtx);

    // Seedream
    case 'Seedream':
      return createSeedreamInput(normalizedData, handlerCtx);

    // Imagen4
    case 'Imagen4':
      return createImagen4Input(normalizedData, handlerCtx);

    // OpenAI
    case 'OpenAI':
      return createOpenAIInput(normalizedData, handlerCtx);

    // NanoBanana
    case 'NanoBanana':
      return createNanoBananaInput(normalizedData, handlerCtx);

    // Ernie
    case 'Ernie':
      return createErnieInput(normalizedData, handlerCtx);

    // Lens (Civitai-internal, comfy)
    case 'Lens':
      return createLensInput(normalizedData, handlerCtx);

    // Krea 2 (Krea AI, FAL engine)
    case 'Krea2':
      return createKrea2Input(normalizedData, handlerCtx);

    // MAI (Microsoft MAI-Image-2.5, FAL engine)
    case 'MAI':
      return createMAIInput(normalizedData, handlerCtx);

    // =========================================================================
    // Video Ecosystems - videoGen step type
    // =========================================================================

    // Wan family (v2.2 returns [videoGen, videoInterpolation]; v2.7 returns [imageGen]; others return [videoGen])
    case 'WanVideo14B_T2V':
    case 'WanVideo14B_I2V_480p':
    case 'WanVideo14B_I2V_720p':
    case 'WanVideo-22-TI2V-5B':
    case 'WanVideo-22-I2V-A14B':
    case 'WanVideo-22-T2V-A14B':
    case 'WanVideo-25-T2V':
    case 'WanVideo-25-I2V':
    case 'WanImage27':
    case 'WanVideo27':
      return createWanSteps(normalizedData, handlerCtx);

    // Vidu
    case 'Vidu':
      return createViduInput(normalizedData, handlerCtx);

    // Kling
    case 'Kling':
      return createKlingInput(normalizedData, handlerCtx);

    // Hunyuan (HyV1)
    case 'HyV1':
      return createHunyuanInput(normalizedData, handlerCtx);

    // LTX (v2 + v2.3)
    case 'LTXV2':
    case 'LTXV23':
      return createLTXInput(normalizedData, handlerCtx);

    // Mochi
    case 'Mochi':
      return createMochiInput(normalizedData, handlerCtx);

    // Sora2
    case 'Sora2':
      return createSoraInput(normalizedData, handlerCtx);

    // Veo3
    case 'Veo3':
      return createVeo3Input(normalizedData, handlerCtx);

    // Seedance
    case 'Seedance':
      return createSeedanceInput(normalizedData, handlerCtx);

    // HappyHorse
    case 'HappyHorse':
      return createHappyHorseInput(normalizedData, handlerCtx);

    // Grok (image + video)
    case 'Grok': {
      const isVideo =
        normalizedData.workflow.startsWith('txt2vid') ||
        normalizedData.workflow.startsWith('img2vid') ||
        normalizedData.workflow.startsWith('vid2vid');
      if (isVideo) {
        return createGrokVideoInput(normalizedData, handlerCtx);
      }
      return createGrokImageInput(normalizedData, handlerCtx);
    }

    // =========================================================================
    // Audio Ecosystems - aceStepAudio step type
    // =========================================================================

    case 'Ace':
      return createAceAudioInput(normalizedData, handlerCtx);

    // =========================================================================
    // 3D Model Ecosystems — polyGen step (Meshy via Fal)
    // =========================================================================

    case 'PolyGen':
      return createPolyGenInput(normalizedData, handlerCtx);

    default:
      throw new Error(`Unknown ecosystem: ${ecosystem}`);
  }
}
