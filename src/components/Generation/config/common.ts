import { WorkflowConfigInputProps } from '~/shared/types/generation.types';

export const promptField: WorkflowConfigInputProps = {
  type: 'textarea',
  name: 'prompt',
  label: 'Prompt',
  placeholder: 'Your prompt goes here...',
  required: true,
  info: `Type out what you'd like to generate in the prompt`,
};

export const negativePromptField: WorkflowConfigInputProps = {
  type: 'textarea',
  name: 'negativePrompt',
  label: 'Negative Prompt',
  placeholder: 'Your negative prompt goes here...',
  info: `add aspects you'd like to avoid in the negative prompt`,
};

export const matureToggleField: WorkflowConfigInputProps = {
  type: 'switch',
  name: 'nsfw',
  label: 'Mature content',
};
