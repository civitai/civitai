import { Workflow as GeneratedWorkflow, WorkflowStep, TextToImageStep } from '@civitai/client';
import { TextToImageStepMetadata } from '~/server/schema/orchestrator/textToImage.schema';

export * from './comfy/comfy.types';

type Workflow<T extends WorkflowStep> = Omit<GeneratedWorkflow, 'steps' | 'metadata'> & {
  steps: Array<T>;
};

export type TextToImageResponse = Workflow<
  Omit<TextToImageStep, 'metadata'> & { metadata?: TextToImageStepMetadata }
>;
