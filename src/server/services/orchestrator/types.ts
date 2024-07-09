import { Workflow as GeneratedWorkflow, WorkflowStep, TextToImageStep } from '@civitai/client';
import { GeneratedImageStepMetadata } from '~/server/schema/orchestrator/textToImage.schema';

export * from './comfy/comfy.types';

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
