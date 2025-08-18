import type { WorkflowStatus, WorkflowStepJobQueuePosition } from '@civitai/client';
import type { formatGenerationResponse } from '~/server/services/orchestrator/common';

export type NormalizedGeneratedImageResponse = AsyncReturnType<
  typeof formatGenerationResponse
>[number];
export type NormalizedGeneratedImageStep = NormalizedGeneratedImageResponse['steps'][number];

interface BaseGeneratedMedia {
  type: string;
  workflowId: string;
  stepName: string;
  jobId: string;
  id: string;
  status: WorkflowStatus;
  seed?: number;
  available?: boolean;
  // completed?: Date;
  url: string;
  width: number;
  height: number;
  reason?: string | null;
  queuePosition?: WorkflowStepJobQueuePosition;
  aspectRatio?: number;
  blockedReason?: string | null;
  nsfwLevel?: string;
}

export interface GeneratedVideo extends BaseGeneratedMedia {
  type: 'video';
  progress: number;
}

export interface GeneratedImage extends BaseGeneratedMedia {
  type: 'image';
}
export type NormalizedGeneratedImage = GeneratedVideo | GeneratedImage;
