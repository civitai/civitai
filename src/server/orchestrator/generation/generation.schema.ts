import { z } from 'zod';
import { VideoGenerationSchema2 } from '~/server/orchestrator/generation/generation.config';
import { videoEnhancementSchema } from '~/server/orchestrator/video-enhancement/video-enhancement.schema';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';

const baseGenerationSchema = z.object({
  civitaiTip: z.number().default(0),
  creatorTip: z.number().default(0),
  tags: z.string().array().optional(),
});

export type GenerationDataSchema = z.infer<typeof generationDataSchema>;
const generationDataSchema = z.discriminatedUnion('$type', [
  z.object({
    $type: z.literal('videoGen'),
    data: z.record(z.any()).transform((data) => data as VideoGenerationSchema2),
  }),
  z.object({
    $type: z.literal('videoEnhancement'),
    data: videoEnhancementSchema,
  }),
  z.object({
    $type: z.literal('image'),
    data: z
      .object({
        workflow: z.string(),
        type: z.enum(['txt2img', 'img2img']),
        prompt: z.string().catch(''),
        seed: z.number().optional(),
      })
      .passthrough(),
  }),
]);

export type GenerationSchema = z.infer<typeof generationSchema>;
export const generationSchema = baseGenerationSchema.and(generationDataSchema);

export function getGenerationTagsForType($type: GenerationDataSchema['$type']) {
  switch ($type) {
    case 'videoGen':
    case 'videoEnhancement':
      return [WORKFLOW_TAGS.VIDEO];
    case 'image':
      return [WORKFLOW_TAGS.IMAGE];
    default:
      throw new Error(`generation tags not implemented for $type: ${$type}`);
  }
}

export function getGenerationTags(args: GenerationDataSchema) {
  const tags = [WORKFLOW_TAGS.GENERATION];
  const type = args.$type;
  switch (args.$type) {
    case 'videoEnhancement':
      tags.push(WORKFLOW_TAGS.VIDEO);
      break;
    case 'videoGen':
      tags.push(WORKFLOW_TAGS.VIDEO, args.data.engine);
      break;
    case 'image':
      tags.push(WORKFLOW_TAGS.IMAGE, args.data.workflow, args.data.type);
      break;
    default:
      throw new Error(`generation tags not implemented for $type: ${type}`);
  }
  return tags;
}
