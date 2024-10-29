import {
  aspectRatioField,
  cfgScaleField,
  clipSkipField,
  denoiseField,
  matureToggleField,
  negativePromptField,
  promptField,
  samplerField,
  sd1AspectRatioField,
  seedField,
  stepsField,
  upscaleField,
} from '~/components/Generation/config/common';
import { GenerationWorkflowConfig } from '~/shared/types/generation.types';
import { ModelType } from '~/server/common/enums';
import Ajv, { JSONSchemaType } from 'ajv';

const workflows2 = [
  // #region [general]
  {
    type: 'image',
    subType: 'txt2img',
    category: 'model',
    env: 'sd1',
    name: 'Standard',
    fields: ['prompt', 'negativePrompt', 'widthAndHeight', 'nsfw'],
    advanced: ['cfgScale', 'sampler', 'steps', 'seed', 'clipSkip'],
    comfy: 'some template',
  },
];

// const workflows = {
//   image: {
//     txt2img: {
//       model: [],
//       service: []
//     },
//     img2img: {
//       model: [],
//       service: []
//     }
//   },
//   video: {
//     txt2img: {
//       model: [],
//       service: []
//     },
//     img2img: {
//       model: [],
//       service: []
//     }
//   }
// }

const environmentConfig = {
  sd1: {
    fields: {
      prompt: '',
      negativePrompt: '',
      width: '',
      height: '',
      nsfw: '',
      cfgScale: '',
      sampler: '',
      steps: '',
      seed: '',
      clipSkip: '',
      denoise: '',
    },
    values: {
      width: 512,
      height: 512,
      cfgScale: 7,
      sampler: 'DPM++ 2M Karras',
      denoise: 0.4,
    },
  },
  sdxl: {
    fields: {
      prompt: '',
      negativePrompt: '',
      width: '',
      height: '',
      nsfw: '',
      cfgScale: '',
      sampler: '',
      steps: '',
      seed: '',
      denoise: '',
    },
    values: {
      clipSkip: 2, // this is a hidden value
    },
  },
  flux1: {
    fields: {
      prompt: '',
      width: '',
      height: '',
      cfgScale: '',
      steps: '',
      seed: '',
    },
    values: {
      sampler: 'unknown',
    },
  },
  sd3: {
    fields: {
      prompt: '',
      negativePrompt: '',
      width: '',
      height: '',
      cfgScale: '',
      steps: '',
      seed: '',
    },
    values: {
      sampler: 'unknown',
    },
  },
};

const engineConfig = {
  haiper: {
    fields: {
      prompt: '',
      negativePrompt: '',
      aspectRatio: '',
      cameraMovement: '',
      duration: '',
      seed: '',
    },
  },
};

export const workflows: GenerationWorkflowConfig[] = [
  // #region [general]
  {
    type: 'image',
    subType: 'img2img',
    category: 'model',
    modelType: ModelType.Upscaler,
    env: 'any',
    name: 'Upscale',
    fields: [upscaleField],
    additionalResources: false,
    values: {
      checkpoint: { id: 'id of default upscale model' },
    },
  },
  // #endregion

  // #region [sd1]
  {
    type: 'image',
    subType: 'txt2img',
    category: 'model',
    env: 'sd1',
    name: 'Standard',
    fields: [promptField, negativePromptField, sd1AspectRatioField, matureToggleField],
    advanced: [cfgScaleField, samplerField, stepsField, seedField, clipSkipField],
  },
  {
    type: 'image',
    subType: 'txt2img',
    category: 'model',
    env: 'sd1',
    name: 'Draft Mode',
    batchSize: 4,
    fields: [promptField, negativePromptField, sd1AspectRatioField, matureToggleField],
    advanced: [seedField, clipSkipField],
    values: {
      steps: 4,
      cfgScale: 1,
    },
  },
  {
    type: 'image',
    subType: 'txt2img',
    category: 'model',
    env: 'sd1',
    name: 'Face Fix',
    fields: [promptField, negativePromptField, sd1AspectRatioField, matureToggleField],
    advanced: [cfgScaleField, samplerField, stepsField, seedField, clipSkipField, denoiseField],
  },
  {
    type: 'image',
    subType: 'txt2img',
    category: 'model',
    env: 'sd1',
    name: 'Hi-res Fix',
    fields: [promptField, negativePromptField, sd1AspectRatioField, matureToggleField],
    advanced: [cfgScaleField, samplerField, stepsField, seedField, clipSkipField, denoiseField],
  },
  {
    type: 'image',
    subType: 'txt2img',
    category: 'model',
    env: 'sd1',
    name: 'Hi-res Fix Face Fix',
    fields: [promptField, negativePromptField, sd1AspectRatioField, matureToggleField],
    advanced: [cfgScaleField, samplerField, stepsField, seedField, clipSkipField, denoiseField],
  },
  // #endregion
  // #region [sdxl]
  {
    type: 'image',
    subType: 'txt2img',
    category: 'model',
    env: 'sdxl',
    name: 'Standard',
    fields: [promptField, negativePromptField, aspectRatioField, matureToggleField],
    advanced: [cfgScaleField, samplerField, stepsField, seedField],
  },
  {
    type: 'image',
    subType: 'txt2img',
    category: 'model',
    env: 'sdxl',
    name: 'Draft Mode',
    batchSize: 4,
    fields: [promptField, negativePromptField, aspectRatioField, matureToggleField],
    advanced: [seedField],
    values: {
      steps: 4,
      cfgScale: 1,
    },
  },
  {
    type: 'image',
    subType: 'txt2img',
    category: 'model',
    env: 'sdxl',
    name: 'Face Fix',
    fields: [promptField, negativePromptField, aspectRatioField, matureToggleField],
    advanced: [cfgScaleField, samplerField, stepsField, seedField, denoiseField],
  },
  {
    type: 'image',
    subType: 'txt2img',
    category: 'model',
    env: 'sdxl',
    name: 'Hi-res Fix',
    fields: [promptField, negativePromptField, aspectRatioField, matureToggleField],
    advanced: [cfgScaleField, samplerField, stepsField, seedField, denoiseField],
  },
  {
    type: 'image',
    subType: 'txt2img',
    category: 'model',
    env: 'sdxl',
    name: 'Hi-res Face Fix',
    fields: [promptField, negativePromptField, aspectRatioField, matureToggleField],
    advanced: [cfgScaleField, samplerField, stepsField, seedField, denoiseField],
  },
  // #endregion
  // #region [flux]
  {
    type: 'image',
    subType: 'txt2img',
    category: 'model',
    env: 'flux1',
    modelId: 618692,
    name: 'Standard',
    fields: [promptField, aspectRatioField],
    advanced: [cfgScaleField, stepsField, seedField],
    values: {
      checkpoint: { id: 691639 },
    },
  },
  {
    type: 'image',
    subType: 'txt2img',
    category: 'model',
    env: 'flux1',
    modelId: 618692,
    name: 'Draft Mode',
    additionalResources: false,
    fields: [promptField, aspectRatioField],
    advanced: [seedField],
    values: {
      checkpoint: { id: 699279 },
      steps: 4,
      cfgScale: 1,
    },
  },
  {
    type: 'image',
    subType: 'txt2img',
    category: 'model',
    env: 'flux1',
    modelId: 618692,
    name: 'Pro',
    additionalResources: false,
    fields: [promptField, aspectRatioField],
    advanced: [cfgScaleField, stepsField, seedField],
    values: {
      checkpoint: { id: 699332 },
    },
  },
  {
    type: 'image',
    subType: 'txt2img',
    category: 'model',
    env: 'flux1',
    modelId: 618692,
    name: 'Pro 1.1',
    additionalResources: false,
    fields: [promptField, aspectRatioField],
    advanced: [cfgScaleField, stepsField, seedField],
    values: {
      checkpoint: { id: 922358 },
    },
  },
  // #endregion
];

// export const sd1WorkflowConfig: GenerationWorkflowConfig = {
//   type: 'image',
//   subType: 'txt2img',
//   category: 'model',
//   env: 'sd1',
//   name: 'Standard',
//   // include: ['prompt', 'negativePrompt']
//   fields: [promptField, negativePromptField, sd1AspectRatioField, matureToggleField],
//   advanced: [cfgScaleField, samplerField, stepsField, seedField],
// };

// export const sd1DraftWorkflowConfig: GenerationWorkflowConfig = {

//   type: 'image',
//   subType: 'txt2img',
//   category: 'model',
//   env: 'sd1',
//   name: 'Draft Mode',
//   batchSize: 4,
//   fields: [promptField, negativePromptField, sd1AspectRatioField, matureToggleField],
//   advanced: [cfgScaleField, samplerField, stepsField, seedField],
// };
// values: {
//   prompt: 'this was a triumph',
//   width: 512,
//   height: 512,
//   cfgScale: 7,
//   sampler: 'DPM++ 2M Karras',
//   denoise: 0.4,
// },

// const ecosystemFields = {
//   sd1: {
//     promptField,
//     negativePromptField,
//   }
// }

export const sdxlWorkflowConfig: GenerationWorkflowConfig = {
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
        { label: 'Square', width: 1024, height: 1024 },
        { label: 'Landscape', width: 1216, height: 832 },
        { label: 'Portrait', width: 832, height: 1216 },
      ],
    },
    matureToggleField,
  ],
  advanced: [cfgScaleField, samplerField, stepsField, seedField, denoiseField],
  // values: {
  //   prompt: 'this was a triumph',
  //   width: 512,
  //   height: 512,
  //   cfgScale: 7,
  //   sampler: 'DPM++ 2M Karras',
  //   denoise: 0.4,
  // },
};

const textToImageSchema: JSONSchemaType<{
  prompt: string;
  negativePrompt: string;
  aspectRatio: string;
}> = {
  type: 'object',
  properties: {
    prompt: { type: 'string', minLength: 0, maxLength: 1500 },
    negativePrompt: { type: 'string', maxLength: 1000 },
    aspectRatio: { type: 'string' },
  },
  required: ['prompt', 'aspectRatio'],
  additionalProperties: false,
};
