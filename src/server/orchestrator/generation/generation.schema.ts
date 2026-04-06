import * as z from 'zod';
import type { VideoGenerationSchema2 } from '~/server/orchestrator/generation/generation.config';
import { imageUpscalerSchema } from '~/server/orchestrator/image-upscaler/image-upscaler';
import { videoEnhancementSchema } from '~/server/orchestrator/video-enhancement/video-enhancement.schema';
import { videoInterpolationSchema } from '~/server/orchestrator/video-interpolation/video-interpolation';
import { videoUpscalerSchema } from '~/server/orchestrator/video-upscaler/video-upscaler.schema';
import { WORKFLOW_TAGS, getProcessTagFromWorkflow } from '~/shared/constants/generation.constants';
import { isDefined } from '~/utils/type-guards';

const baseGenerationSchema = z.object({
  civitaiTip: z.number().default(0),
  creatorTip: z.number().default(0),
  tags: z.string().array().optional(),
});

export type GenerationDataSchema = z.infer<typeof generationDataSchema>;
const generationDataSchema = z.discriminatedUnion('$type', [
  z.object({
    $type: z.literal('videoGen'),
    data: z.record(z.string(), z.any()).transform((data) => data as VideoGenerationSchema2),
  }),
  z.object({
    $type: z.literal('videoEnhancement'),
    data: videoEnhancementSchema,
  }),
  z.object({
    $type: z.literal('videoUpscaler'),
    data: videoUpscalerSchema,
  }),
  z.object({
    $type: z.literal('videoInterpolation'),
    data: videoInterpolationSchema,
  }),
  // z.object({
  //   $type: 'imageUpscaler',
  //   data: imageUpscalerSchema,
  // }),
  z.object({
    $type: z.literal('image'),
    data: z.looseObject({
      workflow: z.string(),
      process: z.enum(['txt2img', 'img2img']),
      prompt: z.string().default('').catch(''),
      seed: z.number().optional(),
    }),
  }),
]);

export type GenerationSchema = z.infer<typeof generationSchema>;
export const generationSchema = baseGenerationSchema.and(generationDataSchema);

export function getGenerationTags(args: GenerationDataSchema) {
  const tags = [WORKFLOW_TAGS.GENERATION];
  const type = args.$type;
  switch (args.$type) {
    case 'videoUpscaler':
      tags.push(WORKFLOW_TAGS.VIDEO, WORKFLOW_TAGS.PROCESS.VID_UPSCALE);
      break;
    case 'videoEnhancement':
      tags.push(WORKFLOW_TAGS.VIDEO, WORKFLOW_TAGS.PROCESS.VID_ENHANCEMENT);
      break;
    case 'videoInterpolation':
      tags.push(WORKFLOW_TAGS.VIDEO, WORKFLOW_TAGS.PROCESS.VID_INTERPOLATION);
      break;
    case 'videoGen': {
      const hasSourceImage = args.data.process === 'img2vid';
      const processTag = getProcessTagFromWorkflow(args.data.engine, hasSourceImage, 'video');
      tags.push(WORKFLOW_TAGS.VIDEO, args.data.engine, args.data.process, processTag);
      break;
    }
    case 'image': {
      const hasSourceImage = args.data.process === 'img2img';
      const processTag = getProcessTagFromWorkflow(args.data.workflow, hasSourceImage, 'image');
      tags.push(WORKFLOW_TAGS.IMAGE, args.data.workflow, args.data.process, processTag);
      break;
    }
    default:
      throw new Error(`generation tags not implemented for $type: ${type}`);
  }
  return tags.filter(isDefined);
}
