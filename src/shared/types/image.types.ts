import type { ImageMetaProps } from '~/server/schema/image.schema';
import type { ModelType } from '~/shared/utils/prisma/enums';

export type ImageModel = {
  id: number;
  url: string;
  name: string | null;
  meta?: ImageMetaProps | null;
  createdAt: Date | null;
};

/** Slim image resource type used for cache and client-side operations */
export interface ImageResourceSlim {
  imageId: number;
  modelVersionId: number;
  strength: number | null;
  detected: boolean;
  modelId: number;
  modelName: string;
  modelType: ModelType;
  modelVersionName: string;
  modelVersionBaseModel: string;
}
