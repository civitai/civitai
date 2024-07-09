import { WorkflowStatus } from '@civitai/client';
import { formatGeneratedImageResponses } from '~/server/services/orchestrator/common';

export type NormalizedGeneratedImageResponse = AsyncReturnType<
  typeof formatGeneratedImageResponses
>[number];
export type NormalizedGeneratedImageStep = NormalizedGeneratedImageResponse['steps'][number];
export type NormalizedGeneratedImage = {
  workflowId: string;
  stepName: string;
  jobId: string;
  id: string;
  status: WorkflowStatus;
  seed?: number;
  completed?: Date;
  url: string;
};
