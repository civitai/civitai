import { VideoGenerationSchema } from '~/server/orchestrator/generation/generation.config';
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

export async function createVideoGenStep(data: VideoGenerationSchema) {
  return {
    $type: 'videoGen' as const,
    input: data,
    metadata: { params: removeEmpty(data) },
  };
}
