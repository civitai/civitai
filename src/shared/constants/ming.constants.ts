/** Ming Design's create route accepts dimensions up to 2048, divisible by 16. */
export const mingResolutions = ['1K', '2K'] as const;
export type MingResolution = (typeof mingResolutions)[number];

export const mingAspectRatios = {
  '1K': [
    { label: '16:9', value: '16:9', width: 1024, height: 576 },
    { label: '4:3', value: '4:3', width: 1024, height: 768 },
    { label: '1:1', value: '1:1', width: 1024, height: 1024 },
    { label: '3:4', value: '3:4', width: 768, height: 1024 },
    { label: '9:16', value: '9:16', width: 576, height: 1024 },
  ],
  '2K': [
    { label: '16:9', value: '16:9', width: 2048, height: 1152 },
    { label: '4:3', value: '4:3', width: 2048, height: 1536 },
    { label: '1:1', value: '1:1', width: 2048, height: 2048 },
    { label: '3:4', value: '3:4', width: 1536, height: 2048 },
    { label: '9:16', value: '9:16', width: 1152, height: 2048 },
  ],
} satisfies Record<
  MingResolution,
  { label: string; value: string; width: number; height: number }[]
>;
