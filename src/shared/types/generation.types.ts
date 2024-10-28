type NodeRef = [string, number];
export type ComfyNode = {
  inputs: Record<string, number | string | NodeRef>;
  class_type: string;
  _meta?: Record<string, string>;
  _children?: { node: ComfyNode; inputKey: string }[];
};

// #region [input builder]
interface BaseInputProps {
  type: string;
  name: string;
  label: string;
  required?: boolean;
  info?: string;
  hidden?: boolean;
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
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  reverse?: boolean;
  presets?: { label: string; value: number }[];
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

export type WorkflowConfigInputProps =
  | TextInputProps
  | TextareaInputProps
  | SwitchInputProps
  | AspectRatioInputProps
  | NumberSliderInputProps
  | SelectInputProps
  | SeedInputProps;
// #endregion

// #region [workflow config]
interface BaseGenerationWorkflowConfig {
  id: number;
  name: string; // ie. Face fix
  description?: string;
  /** used for things like 'draft mode' */ // TODO - determine if this should simply go into `values` prop
  batchSize?: number;
  /** displays an alert message about the generation workflow  */
  message?: string;
  fields: WorkflowConfigInputProps[];
  advanced?: WorkflowConfigInputProps[];
  /** default values used for generation */
  values?: Record<string, unknown>;
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
  env?: string; // ie. sd1, sdxl, flux, sd3
}

interface ServiceGenerationWorkflowConfig {
  category: 'service';
  engine: string;
}

export type GenerationWorkflowConfig = BaseGenerationWorkflowConfig &
  (ImageGenerationWorkflowConfig | VideoGenerationWorkflowConfig) &
  (ModelGenerationWorkflowConfig | ServiceGenerationWorkflowConfig);

// #endregion
