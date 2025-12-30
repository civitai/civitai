import type { Priority, WorkflowStepTemplate } from '@civitai/client';
import { submitWorkflow, TimeSpan } from '@civitai/client';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { logToAxiom } from '~/server/logging/client';
import type { VideoGenerationSchema2 } from '~/server/orchestrator/generation/generation.config';
import { videoGenerationConfig2 } from '~/server/orchestrator/generation/generation.config';
import type { GenerationSchema } from '~/server/orchestrator/generation/generation.schema';
import { createVideoEnhancementStep } from '~/server/orchestrator/video-enhancement/video-enhancement';
import { createVideoUpscalerStep } from '~/server/orchestrator/video-upscaler/video-upscaler';
import { populateWorkflowDefinition } from '~/server/services/orchestrator/comfy/comfy.utils';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { getUpscaleFactor } from '~/shared/constants/generation.constants';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { getRoundedWidthHeight } from '~/utils/image-utils';
import { removeEmpty } from '~/utils/object-helpers';
import { createVideoInterpolationStep } from '~/server/orchestrator/video-interpolation/video-interpolation';

export async function createWorkflowStep(args: GenerationSchema) {
  const type = args.$type;
  switch (args.$type) {
    case 'image':
      return await createImageStep(args.data);
    case 'videoGen':
      return await createVideoGenStep(args.data);
    case 'videoEnhancement':
      return await createVideoEnhancementStep(args.data);
    case 'videoUpscaler':
      return await createVideoUpscalerStep(args.data);
    case 'videoInterpolation':
      return await createVideoInterpolationStep(args.data);
    default:
      throw new Error(`create workflow step not implemented for $type: ${type}`);
  }
}

export async function createVideoGenStep(args: VideoGenerationSchema2) {
  const config = videoGenerationConfig2[args.engine];
  const { priority, ...rest } = args;
  const params: Record<string, any> = removeEmpty(config.metadataFn(rest as any));

  return {
    $type: 'videoGen' as const,
    priority,
    input: config.inputFn(args as any),
    metadata: removeEmpty({ resources: params.resources, params }),
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
  const transformations = [
    ...(args.metadata?.transformations ?? []),
    { type: 'background-removal', ...data },
  ];
  const imageMetadata = JSON.stringify({
    ...args.metadata?.params,
    resources: args.metadata?.resources.map(({ id, strength }: any) => ({
      modelVersionId: id,
      strength: strength,
    })),
    transformations,
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
    metadata: { ...args.metadata, transformations },
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
  const transformations = [...(args.metadata?.transformations ?? []), { type: 'upscale', ...data }];
  const imageMetadata = JSON.stringify({
    ...args.metadata?.params,
    resources: args.metadata?.resources.map(({ id, strength }: any) => ({
      modelVersionId: id,
      strength: strength,
    })),
    transformations,
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
    metadata: { ...args.metadata, transformations },
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
  const transformations = [
    ...(args.metadata?.transformations ?? []),
    { type: 'upscale-enhancement', ...data },
  ];
  const imageMetadata = JSON.stringify({
    ...args.metadata?.params,
    resources: args.metadata?.resources.map(({ id, strength }: any) => ({
      modelVersionId: id,
      strength: strength,
    })),
    transformations,
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
    metadata: { ...args.metadata, transformations },
  };
}

export async function createImageIngestionRequest({
  imageId,
  url,
  callbackUrl,
  priority = 'normal',
  type = 'image',
}: {
  imageId: number;
  url: string;
  callbackUrl: string;
  priority?: Priority;
  type?: MediaType;
}) {
  const metadata = { imageId };
  const edgeUrl = getEdgeUrl(url, { type });

  const { data, error, response } = await submitWorkflow({
    client: internalOrchestratorClient,
    body: {
      metadata,
      arguments: {
        mediaUrl: edgeUrl,
      },
      steps:
        type === 'image'
          ? [
              {
                $type: 'wdTagging',
                name: 'tags',
                metadata,
                priority,
                input: {
                  mediaUrl: { $ref: '$arguments', path: 'mediaUrl' },
                  model: 'wd14-vit.v1',
                  threshold: 0.5,
                },
              } as WorkflowStepTemplate,
              {
                $type: 'mediaRating',
                name: 'rating',
                metadata,
                priority,
                input: {
                  mediaUrl: { $ref: '$arguments', path: 'mediaUrl' },
                  engine: 'civitai',
                },
              } as WorkflowStepTemplate,
              {
                $type: 'mediaHash',
                name: 'hash',
                metadata,
                priority,
                input: {
                  mediaUrl: { $ref: '$arguments', path: 'mediaUrl' },
                  hashTypes: ['perceptual'],
                },
              } as WorkflowStepTemplate,
            ]
          : [
              {
                $type: 'videoFrameExtraction',
                name: 'videoFrames',
                metadata,
                priority,
                input: {
                  videoUrl: { $ref: '$arguments', path: 'mediaUrl' },
                  frameRate: 1,
                  uniqueThreshold: 0.9,
                  maxFrames: 50,
                },
              } as WorkflowStepTemplate,
              {
                $type: 'repeat',
                input: {
                  for: {
                    $ref: 'videoFrames',
                    path: 'output.frames',
                    as: 'frame',
                  },
                  template: {
                    $type: 'wdTagging',
                    name: 'tags',
                    metadata,
                    priority,
                    input: {
                      mediaUrl: {
                        $ref: 'frame',
                        path: 'url',
                      },
                      model: 'wd14-vit.v1',
                      threshold: 0.5,
                    },
                  },
                },
              } as WorkflowStepTemplate,
              {
                $type: 'repeat',
                input: {
                  for: {
                    $ref: 'videoFrames',
                    path: 'output.frames',
                    as: 'frame',
                  },
                  template: {
                    $type: 'mediaRating',
                    name: 'rating',
                    metadata,
                    priority,
                    input: {
                      mediaUrl: {
                        $ref: 'frame',
                        path: 'url',
                      },
                      engine: 'civitai',
                    },
                  },
                },
              } as WorkflowStepTemplate,
            ],
      callbacks: [
        {
          url: `${callbackUrl}`,
          type: ['workflow:succeeded', 'workflow:failed', 'workflow:expired', 'workflow:canceled'],
        },
      ],
    },
  });

  if (!data) {
    logToAxiom({
      type: 'error',
      name: 'image-ingestion',
      imageId,
      url,
      responseStatus: response.status,
      error,
    });
  }

  return data;
}
