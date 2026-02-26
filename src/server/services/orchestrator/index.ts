import type {
  NormalizedWorkflow,
  NormalizedStep,
  NormalizedWorkflowStepOutput,
} from '~/server/services/orchestrator/orchestration-new.service';

export type NormalizedGeneratedImageResponse = NormalizedWorkflow;
export type NormalizedGeneratedImageStep = NormalizedStep;

export type NormalizedGeneratedImage = NormalizedWorkflowStepOutput;
