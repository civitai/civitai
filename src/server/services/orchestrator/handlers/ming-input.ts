import type {
  ComfyMingDesignCreateImageGenInput,
  ComfyMingDesignEditImageGenInput,
  ComfyImageGenInput,
  ImageGenStepTemplate,
} from '@civitai/orchestration-client';
import type { MingResolution } from '~/shared/constants/ming.constants';
import { removeEmpty } from '~/utils/object-helpers';

type MingInput = ComfyMingDesignCreateImageGenInput | ComfyMingDesignEditImageGenInput;

export type MingRequestData = {
  workflow?: string;
  prompt?: string;
  negativePrompt?: string;
  cfgScale?: number;
  steps?: number;
  seed?: number;
  quantity?: number;
  resolution?: MingResolution;
  aspectRatio?: { width: number; height: number };
  images?: { url: string }[];
  outputFormat?: ComfyImageGenInput['outputFormat'];
};

export function buildMingStep(
  data: MingRequestData,
  options?: { loras?: Record<string, number>; diffusionModel?: string }
): ImageGenStepTemplate {
  const common = {
    engine: 'comfy',
    ecosystem: 'ming',
    model: 'design',
    prompt: data.prompt ?? '',
    // Ming runs at cfgScale 1, where the negative prompt has no effect at all.
    negativePrompt: (data.cfgScale ?? 1) === 1 ? undefined : data.negativePrompt,
    cfgScale: data.cfgScale,
    steps: data.steps,
    seed: data.seed,
    quantity: data.quantity ?? 1,
    scheduler: 'simple',
    outputFormat: data.outputFormat,
    loras: options?.loras,
    // The `model` string alone selects the checkpoint; the AIR is what makes the job count
    // against our model version's generations. Same reasoning as the Mage Flow handler.
    diffusionModel: options?.diffusionModel,
  } as const;

  let input: MingInput;
  if (data.workflow === 'img2img:edit') {
    if (!data.images?.length || data.images.length > 3)
      throw new Error('Ming Image editing requires between one and three reference images.');
    input = {
      ...common,
      operation: 'editImage',
      sampler: 'lcm',
      images: data.images.map((image) => image.url),
      resolution: data.resolution === '2K' ? 2048 : 1024,
      // `width`/`height` are `readonly` on the edit input: the route derives them from the first
      // reference image's aspect ratio, so the cast is asserting we deliberately send neither.
    } as ComfyMingDesignEditImageGenInput;
  } else {
    if (data.workflow !== 'txt2img') throw new Error('Unsupported Ming Image workflow.');
    if (!data.aspectRatio) throw new Error('Aspect ratio is required for Ming Image generation.');
    input = {
      ...common,
      operation: 'createImage',
      sampler: 'euler',
      width: data.aspectRatio.width,
      height: data.aspectRatio.height,
    };
  }
  return { $type: 'imageGen', input: removeEmpty(input) };
}
