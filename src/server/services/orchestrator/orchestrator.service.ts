import { TimeSpan } from '@civitai/client';
import { VideoGenerationSchema } from '~/server/orchestrator/generation/generation.config';
import { GenerationSchema } from '~/server/orchestrator/generation/generation.schema';
import { populateWorkflowDefinition } from '~/server/services/orchestrator/comfy/comfy.utils';
import { removeEmpty } from '~/utils/object-helpers';

export async function createWorkflowStep(args: GenerationSchema) {
  switch (args.type) {
    case 'image':
      return await createImageStep(args.data);
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

export async function createImageStep(args: any) {
  switch (args.workflow) {
    case 'img2img-background-removal':
      return await createBackgroundRemovalStep(args);
    default:
      throw new Error(`unsupported generation workflow step type: ${args.workflow}`);
  }
}

async function createBackgroundRemovalStep(args: any) {
  const data: Record<string, unknown> = {};
  if ('sourceImage' in args) {
    data.image = args.sourceImage.url;
    // data.upscaleWidth = args.sourceImage.upscaleWidth;
    // data.upscaleHeight = args.sourceImage.upscaleHeight;
  }

  const comfyWorkflow = await populateWorkflowDefinition(args.workflow, data);
  const imageMetadata = JSON.stringify(args);

  const timeSpan = new TimeSpan(0, 10, 0);

  const { remixOfId, ...params } = args;

  return {
    $type: 'comfy',
    input: {
      quantity: 1,
      comfyWorkflow,
      imageMetadata,
    },
    timeout: timeSpan.toString(['hours', 'minutes', 'seconds']),
    metadata: {
      params,
      remixOfId,
    },
  };
}
