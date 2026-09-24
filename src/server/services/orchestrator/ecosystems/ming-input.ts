import type { ComfyImageGenInput, ImageGenStepTemplate } from '@civitai/orchestration-client';
import type { MingResolution } from '~/shared/constants/ming.constants';
import { removeEmpty } from '~/utils/object-helpers';

// The published client predates Ming. Extend its open Comfy input with the
// fields in ComfyMingDesignCreateImageGenInput / ComfyMingDesignEditImageGenInput.
// This uses the actual route contract without casting to another model's input.
type MingCommonInput = ComfyImageGenInput & {
  ecosystem: 'ming';
  model: 'design';
  prompt: string;
  negativePrompt?: string;
  cfgScale?: number;
  steps?: number;
  seed?: number;
  quantity: number;
  scheduler: 'simple';
  loras?: Record<string, number>;
};
type MingInput = MingCommonInput &
  (
    | { operation: 'createImage'; sampler: 'euler'; width: number; height: number }
    | { operation: 'editImage'; sampler: 'lcm'; images: string[]; resolution: number }
  );

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
  loras?: Record<string, number>
): ImageGenStepTemplate {
  const common: MingCommonInput = {
    engine: 'comfy',
    ecosystem: 'ming',
    model: 'design',
    prompt: data.prompt ?? '',
    negativePrompt: (data.cfgScale ?? 1) === 1 ? undefined : data.negativePrompt,
    cfgScale: data.cfgScale,
    steps: data.steps,
    seed: data.seed,
    quantity: data.quantity ?? 1,
    scheduler: 'simple',
    outputFormat: data.outputFormat,
    loras,
  };
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
    };
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
