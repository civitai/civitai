import { cachedBlockedForPatterns } from '@civitai/shared/media-signals';
import { env } from '$env/dynamic/private';

/** The private `Image.blockedFor` patterns, parsed once per value of the env var. */
export const blockedForPatterns = cachedBlockedForPatterns(
  () => env.REVIEW_SHEET_BLOCKEDFOR_PATTERNS
);
