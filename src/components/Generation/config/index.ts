import {
  matureToggleField,
  negativePromptField,
  promptField,
} from '~/components/Generation/config/common';
import { GenerationWorkflowConfig } from '~/shared/types/generation.types';

export const sd1WorkflowConfig: GenerationWorkflowConfig = {
  id: 1,
  type: 'image',
  subType: 'txt2img',
  category: 'model',
  env: 'sd1',
  name: 'Standard',
  fields: [
    promptField,
    negativePromptField,
    {
      type: 'aspect-ratio',
      label: 'Aspect Ratio',
      options: [
        { label: 'Square', width: 512, height: 512 },
        { label: 'Landscape', width: 768, height: 512 },
        { label: 'Portrait', width: 512, height: 768 },
      ],
    },
    matureToggleField,
  ],
  values: {
    prompt: 'this was a triumph',
    // width: 512,
    // height: 512,
  },
};
