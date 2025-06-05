import type { VideoEnhancementStepTemplate } from '@civitai/client';
import type { VideoEnhancementSchema } from '~/server/orchestrator/video-enhancement/video-enhancement.schema';

export async function createVideoEnhancementStep({
  sourceUrl,
  width,
  height,
  multiplier,
  params,
}: VideoEnhancementSchema): Promise<VideoEnhancementStepTemplate> {
  return {
    $type: 'videoEnhancement',
    input: {
      sourceUrl,
      upscaler: {
        model: 'urn:air:other:upscaler:civitai:147759@164821',
        width,
        height,
      },
      interpolation: multiplier ? { multiplier } : undefined,
    },
    metadata: { params },
  };
}
