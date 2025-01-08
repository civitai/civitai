import {
  promptInput,
  negativePromptInput,
  enablePromptEnhancerInput,
} from '~/server/orchestrator/infrastructure/base.inputs';
import { KlingMode, KlingModel, KlingVideoGenInput } from '@civitai/client';
import z from 'zod';
import { VideoGenerationConfig } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  imageEnhancementSchema,
  negativePromptSchema,
  promptSchema,
  seedSchema,
  textEnhancementSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { WorkflowConfigInputProps } from '~/server/orchestrator/infrastructure/input.types';

export const klingAspectRatios = ['16:9', '1:1', '9:16'] as const;
export const klingDuration = ['5', '10'] as const;

// #region [Schemas]
const baseKlingSchema = z.object({
  engine: z.literal('kling'),
  workflow: z.string(),
  model: z.nativeEnum(KlingModel).default(KlingModel.V1_5).catch(KlingModel.V1_5),
  enablePromptEnhancer: z.boolean().default(true),
  mode: z.nativeEnum(KlingMode).catch(KlingMode.STANDARD),
  duration: z.enum(klingDuration).default('5').catch('5'),
  cfgScale: z.number().min(0).max(1).default(0.5).catch(0.5),
  seed: seedSchema,
});

const klingTxt2VidSchema = textEnhancementSchema.merge(baseKlingSchema).extend({
  negativePrompt: negativePromptSchema,
  aspectRatio: z.enum(klingAspectRatios).default('1:1').catch('1:1'),
});

const klingImg2VidSchema = imageEnhancementSchema
  .merge(baseKlingSchema)
  .extend({ prompt: promptSchema });
// #endregion

// #region [Custom Input]
const klingDurationInput: WorkflowConfigInputProps = {
  type: 'segmented-control',
  label: 'Duration',
  options: klingDuration.map((value) => ({ label: `${value}s`, value })),
};

const klingAspectRatioInput: WorkflowConfigInputProps = {
  type: 'aspect-ratio',
  label: 'Aspect Ratio',
  options: [...klingAspectRatios],
};

const klingModeInput: WorkflowConfigInputProps = {
  type: 'segmented-control',
  label: 'Mode',
  info: 'Standard mode is faster to generate and more cost-effective. Pro takes longer to generate and has higher quality video output.',
  options: [
    { label: 'Standard', value: KlingMode.STANDARD },
    { label: 'Professional', value: KlingMode.PROFESSIONAL },
  ],
};

const klingCfgScaleInput: WorkflowConfigInputProps = {
  type: 'number-slider',
  label: 'CFG Scale',
  info: `Controls how closely the video generation follows the text prompt.
  [Learn more](https://wiki.civitai.com/wiki/Classifier_Free_Guidance)`,
  min: 0,
  max: 1,
  step: 0.1,
  precision: 1,
  reverse: true,
};
// #endregion

const klingTxt2ImgConfig = new VideoGenerationConfig({
  engine: 'kling',
  subType: 'txt2vid',
  schema: klingTxt2VidSchema,
  metadataDisplayProps: ['cfgScale', 'mode', 'aspectRatio', 'duration', 'seed'],
  inputs: [
    'prompt',
    'negativePrompt',
    'enablePromptEnhancer',
    'aspectRatio',
    'duration',
    'mode',
    'cfgScale',
  ],
});

const klingImg2VidConfig = new VideoGenerationConfig({
  engine: 'kling',
  subType: 'img2vid',
  schema: klingImg2VidSchema,
  metadataDisplayProps: ['cfgScale', 'mode', 'duration', 'seed'],
  inputs: ['prompt', 'enablePromptEnhancer', 'duration', 'mode', 'cfgScale'],
});

// const klingGenerationConfig = new GenerationConfig({
//   engine: 'kling',
//   label: 'Kling',
//   inputs: {
//     prompt: promptInput,
//     negativePrompt: negativePromptInput,
//     enablePromptEnhancer: enablePromptEnhancerInput,
//     aspectRatio: klingAspectRatioInput,
//     duration: klingDurationInput,
//     mode: klingModeInput,
//     cfgScale: klingCfgScaleInput,
//   },
// });

// const klingTxt2VidConfig2 = klingGenerationConfig.toClientConfig({
//   subType: 'txt2vid',
//   schema: klingTxt2VidSchema,
//   fields: [
//     'prompt',
//     'negativePrompt',
//     'enablePromptEnhancer',
//     'aspectRatio',
//     'duration',
//     'mode',
//     'cfgScale',
//   ],
// });

// const klingImg2VidConfig2 = klingGenerationConfig.toClientConfig({
//   subType: 'img2vid',
//   schema: klingImg2VidSchema,
//   fields: ['prompt', 'enablePromptEnhancer', 'duration', 'mode', 'cfgScale'],
// });

export const klingVideoGenerationConfig = [klingTxt2ImgConfig, klingImg2VidConfig];

// class ServerGenerationConfig<
//   TInputSchema extends z.AnyZodObject,
//   TOutput extends { [x: string]: any }
// > {
//   toStep(input: z.infer<TInputSchema>): TOutput {
//     return input as TOutput;
//   }
// }

// const klingServerConfig = new ServerGenerationConfig<
//   (typeof klingVideoGenerationConfig)[number]['schema'],
//   KlingVideoGenInput
// >();

// const test = klingServerConfig.toStep({})
