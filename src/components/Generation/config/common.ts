import { samplerOffsets } from '~/server/common/constants';
import { WorkflowConfigInputProps } from '~/shared/types/generation.types';

function fieldFactory<T extends Record<string, WorkflowConfigInputProps>>(dictionary: T) {
  return dictionary as { [K in keyof T]: WorkflowConfigInputProps };
}

const { prompt, negativePrompt, nsfw } = fieldFactory({
  prompt: {
    type: 'textarea',
    name: 'prompt',
    label: 'Prompt',
    placeholder: 'Your prompt goes here...',
    required: true,
    info: `Type out what you'd like to generate in the prompt`,
  },
  negativePrompt: {
    type: 'textarea',
    name: 'negativePrompt',
    label: 'Negative Prompt',
    placeholder: 'Your negative prompt goes here...',
    info: `add aspects you'd like to avoid in the negative prompt`,
  },
  nsfw: {
    type: 'switch',
    name: 'nsfw',
    label: 'Mature content',
  },
});

const sharedSd1SdxlFields = fieldFactory({
  prompt,
  negativePrompt,
  nsfw,
  cfgScale: {
    type: 'number-slider',
    name: 'cfgScale',
    label: 'CFG Scale',
    min: 1,
    max: 30,
    reverse: true,
    precision: 1,
    step: 0.5,
    presets: [
      { label: 'Creative', value: '4' },
      { label: 'Balanced', value: '7' },
      { label: 'Precise', value: '10' },
    ],
    defaultValue: 7,
  },
});

const sd1Fields = fieldFactory({
  ...sharedSd1SdxlFields,
  widthAndHeight: {
    type: 'aspect-ratio',
    label: 'Aspect Ratio',
    options: [
      { label: 'Square', width: 512, height: 512 },
      { label: 'Landscape', width: 768, height: 512 },
      { label: 'Portrait', width: 512, height: 768 },
    ],
  },
});

const sdxlFields = fieldFactory({
  ...sharedSd1SdxlFields,
  widthAndHeight: {
    type: 'aspect-ratio',
    label: 'Aspect Ratio',
    options: [
      { label: 'Square', width: 1024, height: 1024 },
      { label: 'Landscape', width: 1216, height: 832 },
      { label: 'Portrait', width: 832, height: 1216 },
    ],
  },
});

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

export const cfgScaleField: WorkflowConfigInputProps = {
  type: 'number-slider',
  name: 'cfgScale',
  label: 'CFG Scale',
  min: 1,
  max: 30,
  reverse: true,
  precision: 1,
  step: 0.5,
  presets: [
    { label: 'Creative', value: '4' },
    { label: 'Balanced', value: '7' },
    { label: 'Precise', value: '10' },
  ],
  // defaultValue: 7
};

export const sd1AspectRatioField: WorkflowConfigInputProps = {
  type: 'aspect-ratio',
  label: 'Aspect Ratio',
  options: [
    { label: 'Square', width: 512, height: 512 },
    { label: 'Landscape', width: 768, height: 512 },
    { label: 'Portrait', width: 512, height: 768 },
  ],
};

export const aspectRatioField: WorkflowConfigInputProps = {
  type: 'aspect-ratio',
  label: 'Aspect Ratio',
  options: [
    { label: 'Square', width: 1024, height: 1024 },
    { label: 'Landscape', width: 1216, height: 832 },
    { label: 'Portrait', width: 832, height: 1216 },
  ],
};

export const samplerField: WorkflowConfigInputProps = {
  type: 'select',
  name: 'sampler',
  label: 'Sampler',
  options: Object.keys(samplerOffsets),
  presets: [
    { label: 'Fast', value: 'Euler a' },
    { label: 'Popular', value: 'DPM++ 2M Karras' },
  ],
};

export const stepsField: WorkflowConfigInputProps = {
  type: 'number-slider',
  name: 'steps',
  label: 'Steps',
  min: 10,
  max: 50,
  step: 1,
  reverse: true,
  // TODO - verify these presets
  presets: [
    { label: 'Fast', value: '20' },
    { label: 'Balanced', value: '30' },
    { label: 'High', value: '40' },
  ],
};

export const seedField: WorkflowConfigInputProps = {
  type: 'seed',
  name: 'seed',
  label: 'Seed',
};

export const clipSkipField: WorkflowConfigInputProps = {
  type: 'number-slider',
  name: 'clipSkip',
  label: 'Clip Skip',
  min: 1,
  max: 3,
  step: 1,
};

export const denoiseField: WorkflowConfigInputProps = {
  type: 'number-slider',
  name: 'denoise',
  label: 'Denoise',
  min: 0,
  max: 0.75,
  step: 0.05,
};

export const upscaleField: WorkflowConfigInputProps = {
  type: 'upscale',
  name: 'upscale',
  label: 'Upscale',
  sizes: [1024, 2048, 3072, 4096],
};
