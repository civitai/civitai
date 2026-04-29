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

/**
 * Resolve a step's params with workflow fallback. Step params win when present;
 * otherwise we fall back to the workflow-level form input. Used by clients that
 * receive raw NormalizedStep/NormalizedWorkflow objects (no class wrappers).
 */
export function getStepParams(
  step: NormalizedStep,
  workflow?: NormalizedWorkflow
): NonNullable<NormalizedWorkflowMetadata['params']> {
  if (step.metadata?.params) return step.metadata.params;
  return workflow?.metadata?.params ?? ({} as NonNullable<NormalizedWorkflowMetadata['params']>);
}

/**
 * Resolve a step's resources with workflow fallback. Mirrors {@link getStepParams}.
 */
export function getStepResources(
  step: NormalizedStep,
  workflow?: NormalizedWorkflow
): NonNullable<NormalizedWorkflowMetadata['resources']> {
  if (step.metadata?.resources?.length) return step.metadata.resources;
  return (
    workflow?.metadata?.resources ??
    ([] as unknown as NonNullable<NormalizedWorkflowMetadata['resources']>)
  );
}
