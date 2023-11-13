import { BaseModel, BaseModelSetType, ResourceFilter } from '~/server/common/constants';
import { ModelType } from '@prisma/client';

export type ResourceSelectOptions = {
  canGenerate?: boolean;
  resources?: ResourceFilter[];
};
