import {
  GenerationSchema,
  VideoGenerationSchema,
} from '~/server/schema/orchestrator/orchestrator.schema';

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
    $type: 'videoGen',
    input: data,
  };
}
