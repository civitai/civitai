import { TimeSpan } from '@civitai/client';
import type { VideoGenerationSchema2 } from '~/server/orchestrator/generation/generation.config';
import { videoGenerationConfig2 } from '~/server/orchestrator/generation/generation.config';
import type { GenerationSchema } from '~/server/orchestrator/generation/generation.schema';
import { createVideoEnhancementStep } from '~/server/orchestrator/video-enhancement/video-enhancement';
import { populateWorkflowDefinition } from '~/server/services/orchestrator/comfy/comfy.utils';
import { getUpscaleFactor } from '~/shared/constants/generation.constants';
import { getRoundedWidthHeight } from '~/utils/image-utils';
import { removeEmpty } from '~/utils/object-helpers';

export async function createWorkflowStep(args: GenerationSchema) {
  const type = args.$type;
  switch (args.$type) {
    case 'image':
      return await createImageStep(args.data);
    case 'videoGen':
      return await createVideoGenStep(args.data);
    case 'videoEnhancement':
      return await createVideoEnhancementStep(args.data);
    default:
      throw new Error(`create workflow step not implemented for $type: ${type}`);
  }
}

export async function createVideoGenStep(args: VideoGenerationSchema2) {
  const config = videoGenerationConfig2[args.engine];
  const { priority, ...rest } = args;
  return {
    $type: 'videoGen' as const,
    priority,
    input: config.inputFn(args as any),
    metadata: { params: removeEmpty(config.metadataFn(rest as any)) },
  };
}

export async function createImageStep(args: any) {
  switch (args.workflow) {
    case 'img2img-background-removal':
      return await createBackgroundRemovalStep(args);
    case 'img2img-upscale':
      return await createUpscaleImageStep(args);
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
  const imageMetadata = JSON.stringify({
    ...args.metadata?.params,
    resources: args.metadata?.resources.map(({ id, strength }: any) => ({
      modelVersionId: id,
      strength: strength,
    })),
  });

  const timeSpan = new TimeSpan(0, 10, 0);

  return {
    $type: 'comfy',
    input: {
      useSpineComfy: true, // temp
      quantity: 1,
      comfyWorkflow,
      imageMetadata,
    },
    timeout: timeSpan.toString(['hours', 'minutes', 'seconds']),
    metadata: args.metadata,
  };
}

async function createUpscaleImageStep(args: any) {
  const data: Record<string, unknown> = {};
  if ('sourceImage' in args) {
    const sourceImage = args.sourceImage;
    const mod64 = getRoundedWidthHeight({
      width: sourceImage.upscaleWidth,
      height: sourceImage.upscaleHeight,
    });
    data.image = sourceImage.url;
    data.upscaleWidth = mod64.width;
    data.upscaleHeight = mod64.height;
  }

  const comfyWorkflow = await populateWorkflowDefinition(args.workflow, data);
  const imageMetadata = JSON.stringify({
    ...args.metadata?.params,
    resources: args.metadata?.resources.map(({ id, strength }: any) => ({
      modelVersionId: id,
      strength: strength,
    })),
  });

  const timeSpan = new TimeSpan(0, 10, 0);

  return {
    $type: 'comfy',
    input: {
      useSpineComfy: true, // temp
      quantity: 1,
      comfyWorkflow,
      imageMetadata,
    },
    timeout: timeSpan.toString(['hours', 'minutes', 'seconds']),
    metadata: args.metadata,
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
  const imageMetadata = JSON.stringify({
    ...args.metadata?.params,
    resources: args.metadata?.resources.map(({ id, strength }: any) => ({
      modelVersionId: id,
      strength: strength,
    })),
  });

  const timeSpan = new TimeSpan(0, 10, 0);

  return {
    $type: 'comfy',
    input: {
      useSpineComfy: true, // temp
      quantity: 1,
      comfyWorkflow,
      imageMetadata,
    },
    timeout: timeSpan.toString(['hours', 'minutes', 'seconds']),
    metadata: args.metadata,
  };
}
