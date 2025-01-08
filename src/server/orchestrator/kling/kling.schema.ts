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

type OrchestratorSchemaResult<
  OrchestratorInputType,
  DefaultSchema extends z.AnyZodObject = z.AnyZodObject,
  ValidateSchema extends z.AnyZodObject = DefaultSchema
> = {
  defaultSchema: DefaultSchema;
  validateSchema: ValidateSchema;
  transformToInput: (data: z.infer<ValidateSchema>) => OrchestratorInputType;
  transformFromInput: (data: z.infer<ValidateSchema>) => z.infer<DefaultSchema>;
};

class OrchestratorSchema<
  OrchestratorInputType = any,
  T extends OrchestratorSchemaResult<OrchestratorInputType> = OrchestratorSchemaResult<OrchestratorInputType>
> {
  result = {
    defaultSchema: z.object({}).passthrough(),
    validateSchema: z.object({}).passthrough(),
    transformToInput: (data: z.infer<T['validateSchema']>) => data as OrchestratorInputType,
    transformFromInput: (data: z.infer<T['validateSchema']>) => data as z.infer<T['defaultSchema']>,
  } as T;

  constructor(args?: T) {
    if (args?.defaultSchema) this.result.defaultSchema = args.defaultSchema;
    if (args?.validateSchema) this.result.validateSchema = args.validateSchema;
  }

  defaultSchema<TSchema extends z.AnyZodObject>(schema: TSchema) {
    const { defaultSchema, ...rest } = this.result;
    const args = { ...rest, defaultSchema: schema };
    return new OrchestratorSchema<OrchestratorInputType, typeof args>(args);
  }

  validateSchema<TSchema extends z.AnyZodObject>(schema: TSchema) {
    const { validateSchema, ...rest } = this.result;
    const args = { ...rest, validateSchema: schema };
    return new OrchestratorSchema<OrchestratorInputType, typeof args>(args);
  }

  transformToInput(fn: (data: z.infer<T['validateSchema']>) => OrchestratorInputType) {
    const { transformToInput, ...rest } = this.result;
    const args = { ...rest, transformToInput: fn };
    return new OrchestratorSchema<OrchestratorInputType, typeof args>(args);
  }

  transformFromInput(fn: (data: z.infer<T['validateSchema']>) => z.infer<T['defaultSchema']>) {
    const { transformFromInput, ...rest } = this.result;
    const args = { ...rest, transformFromInput: fn };
    return new OrchestratorSchema<OrchestratorInputType, typeof args>(args);
  }
}

const test = new OrchestratorSchema<KlingVideoGenInput>()
  .defaultSchema(klingTxt2VidSchema)
  .validateSchema(klingTxt2VidSchema)
  .transformToInput((data) => {
    return data;
  })
  .transformFromInput((data) => {
    return data;
  }).result;

test.defaultSchema;
test.validateSchema;
const toInput = test.transformToInput({} as any);
const fromInput = test.transformFromInput({});
