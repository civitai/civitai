export type GenerationType = keyof typeof GenerationType;
export const GenerationType = {
  txt2img: 'txt2img',
  img2img: 'img2img',
  txt2vid: 'txt2vid',
  img2vid: 'img2vid',
} as const;

export const GenerationPriorityLevelMap = {
  high: 10,
  normal: 20,
  low: 30,
};
