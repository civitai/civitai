import { ModelType } from '@prisma/client';

export type ResourceSelectOptions = {
  baseModel?: string;
  types?: ModelType[];
  canGenerate?: boolean;
};
