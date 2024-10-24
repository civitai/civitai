import { SupportedBaseModel } from '~/shared/constants/generation.constants';

type BaseInputProps = {
  name: string;
  label: string;
  required?: boolean;
  info?: string;
  advanced?: boolean;
  hidden?: boolean;
};

type ResourceSelectInputProps = BaseInputProps & {
  type: 'resource-select';
  multiple?: boolean;
  value?: { air: string; strength?: number; trainedWords?: string[] }[];
  locked?: boolean;
};

type TextAreaInputProps = BaseInputProps & {
  type: 'text-area';
  value?: string;
};

type TextInputProps = BaseInputProps & {
  type: 'text';
  value?: string;
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

// TODO - determine if value should be set on input props or in separate default values object

export type GeneratorInputProps =
  | ResourceSelectInputProps
  | TextAreaInputProps
  | TextInputProps
  | AspectRatioInputProps
  | SwitchInputProps
  | NumberSliderInputProps
  | SelectInputProps
  | SeedInputProps;

type WorkflowConfig = {
  $type: string; // maps to workflow step $type
  id: number;
  name: string; // ie. Face fix
  description?: string;
  baseModelSetTypes?: SupportedBaseModel[]; // not sure about this one...
  modelId?: number;
  batchSize?: number;
  fields: GeneratorInputProps[];
  next?: number[]; // workflow config ids? workflows that can be used on workflow output?
  groupId?: number; // to group workflows together
};

type WorkflowGroup = {
  id: number;
  name: string; // ie. Text to image
};

// TODO - ability to add workflow config/configId to models
