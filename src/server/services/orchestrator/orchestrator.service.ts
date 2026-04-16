import type { Priority, WorkflowStepTemplate, XGuardModerationStepTemplate } from '@civitai/client';
import { submitWorkflow } from '@civitai/client';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import type { MediaType, ModelType } from '~/shared/utils/prisma/enums';
import { stringifyAIR } from '~/shared/utils/air';

export async function createImageIngestionRequest({
  imageId,
  url,
  callbackUrl,
  wait,
  priority = 'normal',
  type = 'image',
}: {
  imageId: number;
  url: string;
  callbackUrl?: string;
  wait?: number;
  priority?: Priority;
  type?: MediaType;
}) {
  const metadata = { imageId };
  const edgeUrl = getEdgeUrl(url, { type });

  const { data, error, response } = await submitWorkflow({
    client: internalOrchestratorClient,
    query: wait ? { wait } : undefined,
    body: {
      metadata,
      arguments: {
        mediaUrl: edgeUrl,
      },
      currencies: [],
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

export async function createTextModerationRequest({
  entityType,
  entityId,
  content,
  labels,
  callbackUrl,
  wait,
  priority = 'normal',
}: {
  entityType: string;
  entityId: number;
  content: string;
  labels?: string[];
  callbackUrl?: string;
  wait?: number;
  priority?: Priority;
}) {
  const metadata = { entityType, entityId };

  const { data, error, response } = await submitWorkflow({
    client: internalOrchestratorClient,
    query: wait ? { wait } : undefined,
    body: {
      metadata,
      currencies: [],
      steps: [
        {
          $type: 'xGuardModeration',
          name: 'textModeration',
          metadata,
          priority,
          input: {
            text: content,
            mode: 'text',
            labels,
            storeFullResponse: false,
          },
        } as XGuardModerationStepTemplate,
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

  const serverTiming = response?.headers?.get('Server-Timing');

  if (!data) {
    logToAxiom({
      type: 'error',
      name: 'text-moderation',
      entityType,
      entityId,
      responseStatus: response?.status,
      serverTiming,
      error,
    });
  }

  return data;
}

export async function createModelFileScanRequest({
  fileId,
  modelVersionId,
  modelId,
  modelType,
  baseModel,
  priority = 'normal',
}: {
  fileId: number;
  modelVersionId: number;
  modelId: number;
  modelType: ModelType;
  baseModel: string;
  priority?: Priority;
}) {
  const air = stringifyAIR({
    baseModel,
    type: modelType,
    modelId,
    id: modelVersionId,
  });

  const metadata = { fileId, modelVersionId };
  const callbackUrl = `${env.NEXTAUTH_URL}/api/webhooks/model-file-scan-result?token=${env.WEBHOOK_TOKEN}`;

  const { data, error, response } = await submitWorkflow({
    client: internalOrchestratorClient,
    body: {
      metadata,
      currencies: [],
      tags: ['civitai', 'model-scan'],
      steps: [
        {
          $type: 'modelClamScan',
          name: 'clamScan',
          metadata,
          priority,
          input: { model: air },
        } as WorkflowStepTemplate,
        {
          $type: 'modelPickleScan',
          name: 'pickleScan',
          metadata,
          priority,
          input: { model: air },
        } as WorkflowStepTemplate,
        {
          $type: 'modelHash',
          name: 'hash',
          metadata,
          priority,
          input: { model: air },
        } as WorkflowStepTemplate,
        {
          $type: 'modelParseMetadata',
          name: 'parseMetadata',
          metadata,
          priority,
          input: { model: air },
        } as WorkflowStepTemplate,
      ],
      callbacks: [
        {
          url: callbackUrl,
          type: ['workflow:succeeded', 'workflow:failed', 'workflow:expired', 'workflow:canceled'],
        },
      ],
    },
  });

  console.log({ workflowId: data?.id });

  if (!data) {
    logToAxiom({
      type: 'error',
      name: 'model-file-scan',
      fileId,
      modelVersionId,
      air,
      responseStatus: response.status,
      error,
    });
  }

  return data;
}
