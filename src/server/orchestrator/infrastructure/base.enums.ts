export enum EnhancementType {
  TXT = 'txt',
  IMG = 'img',
}

export const OrchestratorEngine = {
  Kling: 'kling',
  Mochi: 'mochi',
  Haiper: 'haiper',
  Minimax: 'minimax',
} as const;
export type OrchestratorEngine = (typeof orchestratorEngines)[number];
const orchestratorEngines = Object.values(OrchestratorEngine);
