import { ImageMetaProps } from '~/server/schema/image.schema';

type MetadataProcessor = {
  canParse: (exif: Record<string, any>) => boolean;
  parse: (exif: Record<string, any>) => ImageMetaProps;
  encode: (meta: ImageMetaProps) => string;
};

export function createMetadataProcessor(processor: MetadataProcessor) {
  return processor;
}

export type SDResource = {
  type: string;
  name: string;
  weight?: number;
  hash?: string;
};
