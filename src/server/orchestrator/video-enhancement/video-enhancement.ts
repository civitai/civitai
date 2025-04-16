import { VideoEnhancementStepTemplate } from '@civitai/client';
import { VideoEnhancementSchema } from '~/server/orchestrator/video-enhancement/video-enhancement.schema';

export async function createVideoEnhancementStep({
  sourceUrl,
  multiplier,
  params,
}: VideoEnhancementSchema): Promise<VideoEnhancementStepTemplate> {
  return {
    $type: 'videoEnhancement',
    input: {
      sourceUrl,
      interpolation: { multiplier },
    },
    metadata: { params },
  };
}
