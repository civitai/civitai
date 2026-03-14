// Type for linked components (used by FilesProvider and Files)
export type LinkedComponent = {
  recommendedResourceId?: number;
  componentType: ModelFileComponentType;
  modelId: number;
  modelName: string;
  versionId: number;
  versionName: string;
  fileId: number;
  fileName: string;
};
