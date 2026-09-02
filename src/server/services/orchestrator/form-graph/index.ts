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
import { createFluxInput } from './flux.handler';
import { createFluxKontextInput } from './flux-kontext.handler';
import { createFlux2Input } from './flux2.handler';
import { createFlux2KleinInput } from './flux2-klein.handler';
import { createBooguInput } from './boogu.handler';
import { createKrea2Input } from './krea2.handler';
import { createImagen4Input } from './imagen4.handler';
import { createPonyV7Input } from './pony-v7.handler';
import { createReveInput } from './reve.handler';
import { createMAIInput } from './mai.handler';
import { createErnieInput } from './ernie.handler';
import { createSeedreamInput } from './seedream.handler';
import { createAnimaInput } from './anima.handler';
import { createMageFlowInput } from './mage-flow.handler';
import { createHiDreamInput } from './hi-dream.handler';
import { createHiDreamO1Input } from './hi-dream-o1.handler';
import { createOpenAIInput } from './openai.handler';
import { createLensInput } from './lens.handler';
import { createQwenInput } from './qwen.handler';
import { createNanoBananaInput } from './nano-banana.handler';
import { createWanImageInput } from './wan-image.handler';
import { createGrokImageInput, createGrokVideoInput } from './grok.handler';
import { createMochiInput } from './mochi.handler';
import { createSoraInput } from './sora.handler';
import { createHunyuanInput } from './hunyuan.handler';
import { createFlux3VideoInput } from './flux3-video.handler';
import { createMiniMaxInput } from './minimax.handler';
import { createHappyHorseInput } from './happy-horse.handler';
import { createVeo3Input } from './veo3.handler';
import { createViduInput } from './vidu.handler';
import { createKlingInput } from './kling.handler';
import { createAceAudioInput } from './ace.handler';
import { createMiniMaxMusicInput } from './minimax-music.handler';
import {
  createPolyGenInput,
  createTripoInput,
  createHunyuan3dInput,
  createPixal3dInput,
  createTrellis2Input,
} from './model3d.handler';
import { createLTXInput } from './ltx.handler';
import { createSeedanceInput } from './seedance.handler';
import { createStableDiffusionInput } from './stable-diffusion.handler';
import { createWanSteps } from './wan.handler';
import { createZImageInput } from './z-image.handler';
import type { GenerationData, LooseGenerationData } from './types';

export type { GenerationData, LooseGenerationData } from './types';
export { createChromaInput } from './chroma.handler';
export { createFluxInput } from './flux.handler';
export { createFluxKontextInput } from './flux-kontext.handler';
export { createFlux2Input } from './flux2.handler';
export { createFlux2KleinInput } from './flux2-klein.handler';
export { createBooguInput } from './boogu.handler';
export { createKrea2Input } from './krea2.handler';
export { createImagen4Input } from './imagen4.handler';
export { createPonyV7Input } from './pony-v7.handler';
export { createReveInput } from './reve.handler';
export { createMAIInput } from './mai.handler';
export { createErnieInput } from './ernie.handler';
export { createSeedreamInput } from './seedream.handler';
export { createAnimaInput } from './anima.handler';
export { createMageFlowInput } from './mage-flow.handler';
export { createHiDreamInput } from './hi-dream.handler';
export { createHiDreamO1Input } from './hi-dream-o1.handler';
export { createOpenAIInput } from './openai.handler';
export { createLensInput } from './lens.handler';
export { createQwenInput } from './qwen.handler';
export { createNanoBananaInput } from './nano-banana.handler';
export { createWanImageInput } from './wan-image.handler';
export { createGrokImageInput, createGrokVideoInput } from './grok.handler';
export { createMochiInput } from './mochi.handler';
export { createSoraInput } from './sora.handler';
export { createHunyuanInput } from './hunyuan.handler';
export { createFlux3VideoInput } from './flux3-video.handler';
export { createMiniMaxInput } from './minimax.handler';
export { createHappyHorseInput } from './happy-horse.handler';
export { createVeo3Input } from './veo3.handler';
export { createViduInput } from './vidu.handler';
export { createKlingInput } from './kling.handler';
export { createAceAudioInput } from './ace.handler';
export { createMiniMaxMusicInput } from './minimax-music.handler';
export {
  createPolyGenInput,
  createTripoInput,
  createHunyuan3dInput,
  createPixal3dInput,
  createTrellis2Input,
} from './model3d.handler';
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
  // Assumes parsed data: the graph never emits enhancedCompatibility for flux
  // ultra (whose step must keep its own engine) — unparsed input would bypass
  // that guarantee.
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

    case 'Flux1':
    case 'FluxKrea':
      return createFluxInput(data, handlerCtx);

    case 'Flux1Kontext':
      return createFluxKontextInput(data, handlerCtx);

    case 'Flux2':
      return createFlux2Input(data, handlerCtx);

    case 'Flux2Klein_9B':
    case 'Flux2Klein_9B_base':
    case 'Flux2Klein_4B':
    case 'Flux2Klein_4B_base':
      return createFlux2KleinInput(data, handlerCtx);

    case 'Boogu':
      return createBooguInput(data, handlerCtx);

    case 'Krea2':
      return createKrea2Input(data, handlerCtx);

    case 'Imagen4':
      return createImagen4Input(data, handlerCtx);

    case 'PonyV7':
      return createPonyV7Input(data, handlerCtx);

    case 'Reve':
      return createReveInput(data, handlerCtx);

    case 'MAI':
      return createMAIInput(data, handlerCtx);

    case 'Ernie':
      return createErnieInput(data, handlerCtx);

    case 'Seedream':
      return createSeedreamInput(data, handlerCtx);

    case 'Anima':
      return createAnimaInput(data, handlerCtx);

    case 'MageFlow':
      return createMageFlowInput(data, handlerCtx);

    case 'HiDream':
      return createHiDreamInput(data, handlerCtx);

    case 'HiDream-O1':
      return createHiDreamO1Input(data, handlerCtx);

    case 'OpenAI':
      return createOpenAIInput(data, handlerCtx);

    case 'Lens':
      return createLensInput(data, handlerCtx);

    case 'Qwen':
    case 'Qwen2':
    case 'Qwen3':
      return createQwenInput(data, handlerCtx);

    case 'NanoBanana':
      return createNanoBananaInput(data, handlerCtx);

    case 'WanImage27':
      return createWanImageInput(data, handlerCtx);

    case 'Grok': {
      const isVideo =
        (data.workflow ?? '').startsWith('txt2vid') ||
        (data.workflow ?? '').startsWith('img2vid') ||
        (data.workflow ?? '').startsWith('vid2vid');
      return isVideo
        ? createGrokVideoInput(data, handlerCtx)
        : createGrokImageInput(data, handlerCtx);
    }

    case 'LTXV2':
    case 'LTXV23':
    case 'LTXV25':
      return createLTXInput(data, handlerCtx);

    case 'Seedance':
      return createSeedanceInput(data, handlerCtx);

    case 'Mochi':
      return createMochiInput(data, handlerCtx);

    case 'Sora2':
      return createSoraInput(data, handlerCtx);

    case 'HyV1':
      return createHunyuanInput(data, handlerCtx);

    case 'Flux3Video':
      return createFlux3VideoInput(data, handlerCtx);

    case 'MiniMaxH3':
      return createMiniMaxInput(data, handlerCtx);

    case 'HappyHorse':
      return createHappyHorseInput(data, handlerCtx);

    case 'Veo3':
      return createVeo3Input(data, handlerCtx);

    case 'Vidu':
      return createViduInput(data, handlerCtx);

    case 'Kling':
      return createKlingInput(data, handlerCtx);

    case 'Ace':
      return createAceAudioInput(data, handlerCtx);

    case 'MiniMaxMusic3':
      return createMiniMaxMusicInput(data, handlerCtx);

    case 'PolyGen':
      return createPolyGenInput(data, handlerCtx);

    case 'Tripo':
      return createTripoInput(data, handlerCtx);

    case 'Hunyuan3D':
      return createHunyuan3dInput(data, handlerCtx);

    case 'Pixal3D':
      return createPixal3dInput(data, handlerCtx);

    case 'Trellis2':
      return createTrellis2Input(data, handlerCtx);

    default:
      throw new Error(`form-graph lane has no handler for ecosystem "${ecosystem}"`);
  }
}
