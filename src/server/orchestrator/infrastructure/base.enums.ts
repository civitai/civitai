export type GenerationType = keyof typeof GenerationType;
export const GenerationType = {
  txt2img: 'txt2img',
  img2img: 'img2img',
  txt2vid: 'txt2vid',
  img2vid: 'img2vid',
} as const;

export const OrchestratorEngine = {
  Kling: 'kling',
  Mochi: 'mochi',
  Haiper: 'haiper',
  Minimax: 'minimax',
  Lightricks: 'lightricks',
} as const;
export type OrchestratorEngine = (typeof orchestratorEngines)[number];
const orchestratorEngines = Object.values(OrchestratorEngine);

export const GenerationPriorityLevelMap = {
  high: 10,
  normal: 20,
  low: 30,
};
