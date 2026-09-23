/** Qwen 2.1 create dimensions must be multiples of 32 and at most 2048 per side. */
export const qwen21ResolutionOptions = ['1K', '2K'] as const;
export type Qwen21Resolution = (typeof qwen21ResolutionOptions)[number];

export const qwen21AspectRatios = {
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
};
