import {
  GenerationSchema,
  VideoGenerationSchema,
} from '~/server/schema/orchestrator/orchestrator.schema';
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
  switch (data.engine) {
    case 'haiper':
      if (data.sourceImageUrl) {
        data.negativePrompt = undefined;
      }
      break;
    case 'mochi':
      if ('negativePrompt' in data) data.negativePrompt = undefined;
      break;
  }

  return {
    $type: 'videoGen',
    input: data,
    metadata: { params: removeEmpty(data) },
  };
}
