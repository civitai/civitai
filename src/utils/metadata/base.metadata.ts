import { isProd } from '~/env/other';
import type { ImageMetaProps } from '~/server/schema/image.schema';

export type MetadataProcessor = {
  canParse: (exif: Record<string, any>) => boolean;
  parse: (exif: Record<string, any>) => ImageMetaProps;
  encode: (meta: ImageMetaProps) => string;
};

export function createMetadataProcessor(processor: MetadataProcessor) {
  return processor;
}

export function setGlobalValue(key: string, value: any) {
  if (isProd || typeof window === 'undefined') return;
  (window as Record<string, any>)[key] = value;
  window.dispatchEvent(new Event('globalValueChange'));
}

export type SDResource = {
  type: string;
  name: string;
  weight?: number;
  hash?: string;
};
