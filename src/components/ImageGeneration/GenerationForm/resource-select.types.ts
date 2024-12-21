export type ResourceSelectOptions = {
  canGenerate?: boolean;
  resources?: { type: string; baseModels?: string[] }[];
  excludeIds?: number[];
};

const selectSources = ['generation', 'training', 'addResource', 'modelVersion'] as const;
export type ResourceSelectSource = (typeof selectSources)[number];
