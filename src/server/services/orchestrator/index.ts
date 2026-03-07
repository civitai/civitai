import type {
  NormalizedWorkflow,
  NormalizedWorkflowMetadata,
  NormalizedStep,
  NormalizedStepMetadata,
  NormalizedWorkflowStepOutput,
} from '~/server/services/orchestrator/orchestration-new.service';

export type NormalizedGeneratedImageResponse = NormalizedWorkflow;
export type NormalizedGeneratedImageStep = NormalizedStep;
export type { NormalizedStepMetadata, NormalizedWorkflowMetadata };

export type NormalizedGeneratedImage = NormalizedWorkflowStepOutput;

// Re-export data classes from shared
export { WorkflowData, StepData, BlobData } from '~/shared/orchestrator/workflow-data';
export type { WorkflowDataOptions } from '~/shared/orchestrator/workflow-data';
