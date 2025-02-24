import { TimeSpan } from '@civitai/client';
import { VideoGenerationSchema } from '~/server/orchestrator/generation/generation.config';
import { GenerationSchema } from '~/server/orchestrator/generation/generation.schema';
import { populateWorkflowDefinition } from '~/server/services/orchestrator/comfy/comfy.utils';
import { getUpscaleFactor } from '~/shared/constants/generation.constants';
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
    case 'img2img-upscale-enhancement-realism':
      return await createUpscaleEnhancementStep(args);
    default:
      throw new Error(`unsupported generation workflow step type: ${args.workflow}`);
  }
}

async function createBackgroundRemovalStep(args: any) {
  const data: Record<string, unknown> = {};
  if ('sourceImage' in args) {
    data.image = args.sourceImage.url;
    data.width = args.sourceImage.width;
    data.height = args.sourceImage.height;
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
      useSpineComfy: true, // temp
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

async function createUpscaleEnhancementStep(args: any) {
  const data: Record<string, unknown> = {};
  data.steps = args.steps;
  if ('sourceImage' in args) {
    data.image = args.sourceImage.url;
    data.upscaleFactor = getUpscaleFactor(
      { width: args.sourceImage.width, height: args.sourceImage.height },
      { width: args.sourceImage.upscaleWidth, height: args.sourceImage.upscaleHeight }
    );
  }

  const comfyWorkflow = await populateWorkflowDefinition(args.workflow, data);
  const imageMetadata = JSON.stringify(args);

  const timeSpan = new TimeSpan(0, 10, 0);

  const { remixOfId, ...params } = args;

  return {
    $type: 'comfy',
    input: {
      useSpineComfy: true, // temp
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
