import type { VideoInterpolationStepTemplate } from '@civitai/client';
import * as z from 'zod';

export type VideoInterpolationSchema = z.infer<typeof videoInterpolationSchema>;
export const videoInterpolationSchema = z.object({
  videoUrl: z.string(),
  interpolationFactor: z.number(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export async function createVideoInterpolationStep({
  videoUrl,
  interpolationFactor,
  metadata,
}: VideoInterpolationSchema): Promise<VideoInterpolationStepTemplate> {
  const transformations = [
    ...(metadata?.transformations ?? []),
    { workflow: 'vid2vid:interpolate', video: videoUrl, interpolationFactor },
  ];
  return {
    $type: 'videoInterpolation',
    input: {
      video: videoUrl,
      interpolationFactor,
    },
    metadata: { ...metadata, transformations },
  };
}
