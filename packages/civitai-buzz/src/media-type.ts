import { getBaseModelMediaType } from '@civitai/shared/basemodel.constants';
import type { CapMediaType } from './licensing-fee';

/**
 * The media axis the monetization caps resolve against. Only image and video exist: an ecosystem typed
 * for both resolves to image (getBaseModelMediaType returns its first type), and anything we can't match
 * — an unknown base model, 'Other', audio, 3D — also prices as image. Image is the strictest of the two,
 * so a miss can only ever under-charge, never let a creator exceed a ceiling they haven't earned.
 */
export function capMediaType(baseModel: string | null | undefined): CapMediaType {
  if (!baseModel) return 'image';
  return getBaseModelMediaType(baseModel) === 'video' ? 'video' : 'image';
}
