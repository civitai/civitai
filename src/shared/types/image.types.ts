import type { ImageMetaProps } from '~/server/schema/image.schema';

export type ImageModel = {
  id: number;
  url: string;
  name: string | null;
  meta?: ImageMetaProps | null;
  createdAt: Date | null;
};
