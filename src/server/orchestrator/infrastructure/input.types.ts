type SharedProps = {
  info?: string;
  label: string;
};

type AspectRatioInput = SharedProps & {
  type: 'aspect-ratio';
  baseResolution?: number; // 512 for sd1, 1024 for other base models
  options: string[]; // colon delimited list - 9:16, 1:1, 16:9
};

type PromptInput = SharedProps & {
  type: 'prompt';
  placeholder?: string;
};

type SwitchInput = SharedProps & {
  type: 'switch';
};

type SegmentedControlInput = SharedProps & {
  type: 'segmented-control';
  options:
    | string[]
    | number[]
    | { label: string; value: string }[]
    | { label: string; value: number }[];
};

type SeedInput = SharedProps & {
  type: 'seed';
  max: number;
};

type NumberSliderInput = SharedProps & {
  type: 'number-slider';
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  reverse?: boolean;
  presets?: { label: string; value: number }[];
};

export type WorkflowConfigInputProps =
  | PromptInput
  | AspectRatioInput
  | SwitchInput
  | SegmentedControlInput
  | SeedInput
  | NumberSliderInput;
