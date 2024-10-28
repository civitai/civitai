// #region [base props]
interface BaseInputProps {
  type: string;
  name: string;
  label: string;
  required?: boolean;
  info?: string;
  hidden?: boolean;
  disabled?: boolean;
}

interface PlaceholderInputProps extends BaseInputProps {
  placeholder?: string;
}
// #endregion

// #region [input props]
interface TextInputProps extends PlaceholderInputProps {
  type: 'text';
}

interface TextareaInputProps extends PlaceholderInputProps {
  type: 'textarea';
  minRows?: number;
}

interface AspectRatioInputProps extends BaseInputProps {
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
// #endregion

export type InputBuilderProps =
  | TextInputProps
  | TextareaInputProps
  | AspectRatioInputProps
  | NumberSliderInputProps
  | SelectInputProps
  | SeedInputProps;
