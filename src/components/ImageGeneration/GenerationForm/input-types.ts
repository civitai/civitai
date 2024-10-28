import Ajv, { JSONSchemaType } from 'ajv';

type BaseInputProps = {
  name: string;
  label: string;
  required?: boolean;
  info?: string;
  advanced?: boolean;
  hidden?: boolean;
};

type TextAreaInputProps = BaseInputProps & {
  type: 'textarea';
  value?: string;
  placeholder?: string;
};

type TextInputProps = BaseInputProps & {
  type: 'text';
  value?: string;
  placeholder?: string;
};

type AspectRatioInputProps = BaseInputProps & {
  type: 'aspect-ratio';
  value?: string;
  options: { label: string; width: number; height: number }[];
};

type SwitchInputProps = BaseInputProps & {
  type: 'switch';
  checked?: boolean;
};

type NumberSliderInputProps = BaseInputProps & {
  type: 'number-slider';
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  reverse?: boolean;
  presets?: { label: string; value: number }[];
};

type SelectInputProps = BaseInputProps & {
  type: 'select';
  value?: string;
  options: string[] | { label: string; value: string }[];
  presets?: { label: string; value: string }[];
};

type SeedInputProps = BaseInputProps & {
  type: 'seed';
  value?: number;
  min?: number;
  max?: number;
};

export type GeneratorInputProps =
  // | ResourceSelectInputProps
  | TextAreaInputProps
  | TextInputProps
  | AspectRatioInputProps
  | SwitchInputProps
  | NumberSliderInputProps
  | SelectInputProps
  | SeedInputProps;

type GenerationConfigGroup = {
  id: number;
  type: 'image' | 'video';
  name: string; // ie. Text to Image, Image to Image, Flux
  modelId?: number;
  env?: string; // ie. sd1, sdxl, flux, sd3
};

type BaseGenerationConfig = {
  id: number; // workflow id would map to a recipe/$type
  type: 'image' | 'video';
  name: string; // ie. Face fix
  description?: string;
  batchSize?: number;
};

type Test = {
  type: 'image';
  subType: 'txt2img' | 'img2img';
};

type Tes2 = {
  type: 'video';
  subType: 'txt2vid' | 'img2vid';
};

type GenerationModelConfig = BaseGenerationConfig & {
  category: 'model';
  modelId?: number;
  env?: string; // ie. sd1, sdxl, flux, sd3
};

type GenerationServiceConfig = BaseGenerationConfig & {
  category: 'service';
  engine: string;
};

type GenerationConfig = GenerationModelConfig | GenerationServiceConfig;

type GenerationConfigToInput = {
  generationConfigId: number;
  generationInputId: number;
};

type GenerationInput = {
  id: number;
  name: string;
  data: GeneratorInputProps;
};

const group1: GenerationConfigGroup = {
  id: 1,
  type: 'image',
  name: 'Text to Image',
  baseModel: 'SD1',
  // modelId: 618692
};

const config1: GenerationConfig = {
  id: 1,
  // groupId: 1,
  category: 'model',
  name: 'Standard',
  // fields: [
  //   { type: 'resource-select', name: 'resources', label: 'Additional Resources', multiple: true },
  //   {
  //     type: 'textarea',
  //     name: 'prompt',
  //     label: 'Prompt',
  //     placeholder: 'Your prompt goes here...',
  //     required: true,
  //     info: `Type out what you'd like to generate in the prompt, add aspects you'd like to avoid in the negative prompt`,
  //   },
  //   {
  //     type: 'textarea',
  //     name: 'negativePrompt',
  //     label: 'Negative Prompt',
  //     placeholder: 'Your negative prompt goes here...',
  //   },
  //   {
  //     type: 'aspect-ratio',
  //     name: 'aspectRatio',
  //     label: 'Aspect Ratio',
  //     options: [
  //       { label: 'Square', width: 512, height: 512 },
  //       { label: 'Landscape', width: 768, height: 512 },
  //       { label: 'Portrait', width: 512, height: 768 },
  //     ],
  //   },
  // ],
};

/**
 * TODO - add model light descriptions
 * An embedding is a lightweight file that enhances a model's understanding of existing concepts without adding new data.
 *  A LoRA is a lightweight add-on to a base model, designed to generate specific styles or themes of which the base model has no concept. See also DoRA, LoCon, LyCORIS. - then link to that doc?
 *
 */

const prompt: TextAreaInputProps = {
  type: 'textarea',
  name: 'prompt',
  label: 'Prompt',
  placeholder: 'Your prompt goes here...',
  required: true,
  info: `Type out what you'd like to generate in the prompt`,
};
const negativePrompt: TextAreaInputProps = {
  type: 'textarea',
  name: 'negativePrompt',
  label: 'Negative Prompt',
  placeholder: 'Your negative prompt goes here...',
  info: `add aspects you'd like to avoid in the negative prompt`,
};
const aspectRatioSd1: AspectRatioInputProps = {
  type: 'aspect-ratio',
  name: 'aspectRatio',
  label: 'Aspect Ratio',
  options: [
    { label: 'Square', width: 512, height: 512 },
    { label: 'Landscape', width: 768, height: 512 },
    { label: 'Portrait', width: 512, height: 768 },
  ],
};
const matureToggle: SwitchInputProps = {
  type: 'switch',
  name: 'nsfw',
  label: 'Mature content',
};
const aspectRatio = {
  type: 'aspect-ratio',
  name: 'aspectRatio',
  label: 'Aspect Ratio',
  options: [
    { label: 'Square', width: 1024, height: 1024 },
    { label: 'Landscape', width: 1216, height: 832 },
    { label: 'Portrait', width: 832, height: 1216 },
  ],
};

const sd1Config = [prompt, negativePrompt, aspectRatioSd1, matureToggle];
const sdxlConfig = [prompt, negativePrompt, aspectRatio, matureToggle];
const fluxConfig = [prompt, aspectRatio];

// can this be included by default. Could we add something like `supportsAdditionalResources` to the generation config?
const sd1ResourceSelect: ResourceSelectInputProps = {
  type: 'resource-select',
  name: 'resources',
  label: 'Additional Resources',
  multiple: true,
  resources: [
    // TODO - determine if this is redundant - could this simply be defined in generation.constants, including setting limits on number of resources?
    { type: 'TextualInversion' },
    { type: 'LORA' },
    { type: 'DoRA' },
    { type: 'LoCon' },
  ],
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

const environmentConfigs = {
  sd1: {},
  sdxl: {},
  flux: {},
  sd3: {},
};
