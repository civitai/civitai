import { Workflow as GeneratedWorkflow, WorkflowStep, TextToImageStep } from '@civitai/client';

type Workflow<T extends WorkflowStep> = Omit<GeneratedWorkflow, 'steps'> & { steps: Array<T> };

export type TextToImageResponse = Workflow<TextToImageStep>;
