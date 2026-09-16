export const yue2ModeOptions = [
  { label: 'Melody + chords', value: 'full' as const },
  { label: 'Melody only', value: 'melody' as const },
  { label: 'Off', value: 'off' as const },
];

export const yue2Duration = { min: 1, max: 360, step: 1, default: 120 };
export const yue2Steps = { min: 1, max: 100, step: 1, default: 32 };
