import { DEFAULT_UPSCALER_AIR } from '~/shared/constants/basemodel.constants';
import type { VideoEnhancementStepTemplate } from '@civitai/orchestration-client';
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
        model: DEFAULT_UPSCALER_AIR,
        width,
        height,
      },
      interpolation: multiplier ? { multiplier } : undefined,
    },
    metadata: { params },
  };
}
