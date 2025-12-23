import type { VideoUpscalerSchema } from './video-upscaler.schema';
import type { VideoUpscalerStepTemplate } from '@civitai/client';

export async function createVideoUpscalerStep({
  videoUrl,
  scaleFactor,
  metadata,
}: VideoUpscalerSchema): Promise<VideoUpscalerStepTemplate> {
  const transformations = [
    ...(metadata?.transformations ?? []),
    { type: 'upscale', video: videoUrl, scaleFactor },
  ];
  return {
    $type: 'videoUpscaler',
    input: {
      video: videoUrl,
      scaleFactor,
    },
    metadata: { ...metadata, transformations },
  };
}
