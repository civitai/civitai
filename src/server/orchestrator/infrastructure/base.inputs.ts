import { generation } from '~/server/common/constants';
import { WorkflowConfigInputProps } from './input.types';

export const promptInput: WorkflowConfigInputProps = {
  type: 'prompt',
  label: 'Prompt',
  placeholder: 'Your prompt goes here...',
};

export const negativePromptInput: WorkflowConfigInputProps = {
  type: 'prompt',
  label: 'Negative Prompt',
};

export const enablePromptEnhancerInput: WorkflowConfigInputProps = {
  type: 'switch',
  label: 'Enable Prompt Enhancer',
};

export const seedInput: WorkflowConfigInputProps = {
  type: 'seed',
  label: 'Seed',
  max: generation.maxValues.seed,
};
