import { isProd } from '~/env/other';
import { samplerMap } from '~/server/common/constants';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { findKeyForValue } from '~/utils/map-helpers';

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

/** Maps sampler names to A1111-compatible names for cross-format consistency. */
export function a1111Compatibility(
  metadata: ImageMetaProps,
  options?: { preserveOriginal?: boolean }
) {
  const samplerName = metadata.sampler;
  if (options?.preserveOriginal) metadata.originalSampler = samplerName;
  let a1111sampler: string | undefined;
  if (metadata.scheduler == 'karras') {
    a1111sampler = findKeyForValue(samplerMap, samplerName + '_karras');
  }
  if (!a1111sampler) a1111sampler = findKeyForValue(samplerMap, samplerName);
  if (a1111sampler) metadata.sampler = a1111sampler;

  // Model name cleanup
  const models = metadata.models as string[] | undefined;
  if (models && models.length > 0) {
    metadata.Model = models[0].replace(/\.[^/.]+$/, '');
  }
}
