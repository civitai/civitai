import { Workflow as GeneratedWorkflow, WorkflowStep, TextToImageStep } from '@civitai/client';

type Workflow<T extends WorkflowStep> = Omit<GeneratedWorkflow, 'steps'> & { steps: Array<T> };

export type TextToImageResponse = Workflow<TextToImageStep>;

export enum WorkflowStatus {
  unassigned = 'unassigned',
  preparing = 'preparing',
  scheduled = 'scheduled',
  processing = 'processing',
  succeeded = 'succeeded',
  failed = 'failed',
  expired = 'expired',
  canceled = 'canceled',
}

export enum CallbackSource {
  workflow = 'workflow',
  step = 'step',
  job = 'job',
}
