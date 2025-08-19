import type {
  NormalizedWorkflowStepOutput,
  formatGenerationResponse,
} from '~/server/services/orchestrator/common';

export type NormalizedGeneratedImageResponse = AsyncReturnType<
  typeof formatGenerationResponse
>[number];
export type NormalizedGeneratedImageStep = NormalizedGeneratedImageResponse['steps'][number];

export type NormalizedGeneratedImage = NormalizedWorkflowStepOutput;
