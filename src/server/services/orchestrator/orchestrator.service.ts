import type { Priority, WorkflowStepTemplate } from '@civitai/client';
import { submitWorkflow } from '@civitai/client';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { logToAxiom } from '~/server/logging/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import type { MediaType } from '~/shared/utils/prisma/enums';

export async function createImageIngestionRequest({
  imageId,
  url,
  callbackUrl,
  priority = 'normal',
  type = 'image',
}: {
  imageId: number;
  url: string;
  callbackUrl?: string;
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
      callbacks: callbackUrl
        ? [
            {
              url: `${callbackUrl}`,
              type: [
                'workflow:succeeded',
                'workflow:failed',
                'workflow:expired',
                'workflow:canceled',
              ],
            },
          ]
        : undefined,
    },
  });

  const serverTiming = response.headers.get('Server-Timing');

  if (!data) {
    logToAxiom({
      type: 'error',
      name: 'image-ingestion',
      imageId,
      url,
      responseStatus: response.status,
      serverTiming,
      error,
    });
  }

  return data;
}
