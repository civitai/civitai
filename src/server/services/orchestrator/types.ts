import type {
  Workflow as GeneratedWorkflow,
  WorkflowStep,
  TextToImageStep,
  WorkflowCost,
} from '@civitai/client';
import type { GeneratedImageStepMetadata } from '~/server/schema/orchestrator/textToImage.schema';

export * from './comfy/comfy.types';

export type GenerationWhatIfResponse = {
  cost?: WorkflowCost;
  ready: boolean;
  eta: Date;
  position: number;
};

export type GeneratedImageWorkflowStep = Omit<WorkflowStep, 'metadata'> & {
  metadata?: GeneratedImageStepMetadata;
};

export type GeneratedImageWorkflow = Omit<GeneratedWorkflow, 'metadata'> & {
  steps: GeneratedImageWorkflowStep[];
};

type Workflow<T extends WorkflowStep> = Omit<GeneratedWorkflow, 'steps'> & {
  steps: Array<T>;
};

export type TextToImageResponse = Workflow<
  Omit<TextToImageStep, 'metadata'> & { metadata?: GeneratedImageStepMetadata }
>;
