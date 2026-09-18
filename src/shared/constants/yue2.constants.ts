export const yue2MusicModeOptions = [
  { label: 'Simple', value: 'simple' as const },
  { label: 'Custom', value: 'custom' as const },
];

export const yue2ModeOptions = [
  { label: 'Melody + chords', value: 'full' as const },
  { label: 'Melody only', value: 'melody' as const },
  { label: 'Off', value: 'off' as const },
];

export const yue2ScorePlanningInfo =
  'Guides the song with a musical score. Melody + chords plans the tune and chord progression; Melody only plans the tune. Off skips the score and ignores ABC input. With planning enabled, supply an ABC score or let YuE2 compose one from your music description and lyrics. Automatic planning adds time and cost.';

export const yue2Duration = { min: 1, max: 360, step: 1, default: 120 };
export const yue2Steps = { min: 1, max: 100, step: 1, default: 32 };
