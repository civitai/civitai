export type SoniloOperation = 'music' | 'soundEffect';

export const soniloOperationOptions = [
  { label: 'Music', value: 'music' as const },
  { label: 'Sound effect', value: 'soundEffect' as const },
];

export const soniloVersionIds = {
  'V1.1': 3370181,
} as const;

// min/max are Sonilo's API limits (platform.sonilo.com/llms-full.txt); step and default are ours.
export const soniloDuration = {
  music: { min: 5, max: 360, step: 5, default: 60 },
  soundEffect: { min: 0.5, max: 180, step: 0.5, default: 8 },
};

export const SONILO_MAX_PROMPT_LENGTH = 2000;
