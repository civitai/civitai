type NodeRef = [string, number];
export type ComfyNode = {
  inputs: Record<string, number | string | NodeRef>;
  class_type: string;
  _meta?: Record<string, string>;
  _children?: { node: ComfyNode; inputKey: string }[];
};

// #region [input builder]
type InputValue = string | number | boolean;
type SupportedEnv = 'sd1' | 'sdxl' | 'flux1' | 'sd3' | 'any';
interface BaseInputProps {
  type: string;
  name: string;
  label: string;
  required?: boolean;
  info?: string;
  hidden?: boolean;
  defaultValue?: InputValue | Record<string, InputValue>;
  // env?: string | string[];
  // modelId?: string;
}

interface EnvironmentOptions {
  env: SupportedEnv | SupportedEnv[];
}

interface PlaceholderInputProps extends BaseInputProps {
  placeholder?: string;
}

interface TextInputProps extends PlaceholderInputProps {
  type: 'text';
}

interface SwitchInputProps extends BaseInputProps {
  type: 'switch';
}

interface TextareaInputProps extends PlaceholderInputProps {
  type: 'textarea';
  minRows?: number;
}

interface AspectRatioInputProps extends Omit<BaseInputProps, 'name'> {
  type: 'aspect-ratio';
  options: { label: string; width: number; height: number }[];
}

interface NumberSliderInputProps extends BaseInputProps {
  type: 'number-slider';
  min: number;
  max: number;
  step: number;
  precision?: number;
  reverse?: boolean;
  presets?: { label: string; value: string }[];
}

interface SelectInputProps extends PlaceholderInputProps {
  type: 'select';
  options: string[] | { label: string; value: string }[];
  presets?: { label: string; value: string }[];
}

interface SeedInputProps extends BaseInputProps {
  type: 'seed';
  min?: number;
  max?: number;
}

interface UpscaleInputProps extends BaseInputProps {
  type: 'upscale';
  sizes: number[];
}

export type WorkflowConfigInputProps =
  | TextInputProps
  | TextareaInputProps
  | SwitchInputProps
  | AspectRatioInputProps
  | NumberSliderInputProps
  | SelectInputProps
  | SeedInputProps
  | UpscaleInputProps;
// #endregion

// #region [workflow config]
interface BaseGenerationWorkflowConfig {
  // id: number;
  name: string; // ie. Face fix
  description?: string;
  /** used for things like 'draft mode' */ // TODO - determine if this should simply go into `values` prop
  batchSize?: number;
  /** displays an alert message about the generation workflow  */
  message?: string;
  fields: WorkflowConfigInputProps[];
  advanced?: WorkflowConfigInputProps[];
  /** default values used for generation */
  values?: Record<string, any>;
}

interface ImageGenerationWorkflowConfig {
  type: 'image';
  subType: 'txt2img' | 'img2img';
}

interface VideoGenerationWorkflowConfig {
  type: 'video';
  subType: 'txt2vid' | 'img2vid';
}

interface ModelGenerationWorkflowConfig {
  category: 'model';
  modelId?: number;
  env: SupportedEnv | SupportedEnv[]; // ie. sd1, sdxl, flux, sd3
  modelType?: string | string[];
  checkpointSelect?: boolean; // not sure about this one
  additionalResources?: boolean;
}

interface ServiceGenerationWorkflowConfig {
  category: 'service';
  engine: string;
}

export type GenerationWorkflowConfig = BaseGenerationWorkflowConfig &
  (ImageGenerationWorkflowConfig | VideoGenerationWorkflowConfig) &
  (ModelGenerationWorkflowConfig | ServiceGenerationWorkflowConfig);

// #endregion
