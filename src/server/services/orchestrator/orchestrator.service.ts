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

export async function createVideoGenStep({ priority, ...data }: VideoGenerationSchema) {
  let sourceImage: string | undefined;
  if ('sourceImage' in data) sourceImage = data.sourceImage.url;

  return {
    $type: 'videoGen' as const,
    priority,
    input: { ...data, sourceImage },
    metadata: { params: removeEmpty(data) },
  };
}
