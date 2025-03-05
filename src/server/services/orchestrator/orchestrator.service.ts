import {
  VideoGenerationSchema,
  videoGenerationInput,
} from '~/server/orchestrator/generation/generation.config';
import { GenerationSchema } from '~/server/orchestrator/generation/generation.schema';
import { removeEmpty } from '~/utils/object-helpers';

export async function createWorkflowStep(args: GenerationSchema) {
  switch (args.type) {
    case 'image':
      throw new Error('unsupported generation workflow step type: "image"');
    case 'video':
      return await createVideoGenStep(args.data);
  }
}

export async function createVideoGenStep(args: VideoGenerationSchema) {
  const inputParser = videoGenerationInput[args.engine];
  const { priority, ...rest } = args;
  return {
    $type: 'videoGen' as const,
    priority,
    input: inputParser(args as any),
    metadata: { params: removeEmpty(rest) },
  };
}
