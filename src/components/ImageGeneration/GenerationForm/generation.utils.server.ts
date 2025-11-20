/**
 * Server-safe generation utilities
 * This file contains utilities that can be safely imported by server-side code
 * without causing circular dependencies through dialog imports
 */

import type { ImageMetaProps } from '~/server/schema/image.schema';
import { videoGenerationConfig2 } from '~/server/orchestrator/generation/generation.config';

/**
 * Checks if an image was generated on Civitai
 */
export const isMadeOnSite = (meta: ImageMetaProps | null) => {
  if (!meta) return false;
  if ('civitaiResources' in meta) return true;
  if (meta.engine && Object.keys(videoGenerationConfig2).includes(meta.engine as string))
    return true;
  return false;
};
