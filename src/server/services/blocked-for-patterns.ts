import { parseBlockedForPatterns } from '@civitai/shared/review-batch';
import { env } from '~/env/server';

let patternsRaw: string | undefined;
let patterns: ReturnType<typeof parseBlockedForPatterns> = null;

/** The private `Image.blockedFor` patterns, parsed once per value of the env var. */
export function blockedForPatterns() {
  if (env.REVIEW_SHEET_BLOCKEDFOR_PATTERNS !== patternsRaw) {
    patternsRaw = env.REVIEW_SHEET_BLOCKEDFOR_PATTERNS;
    patterns = parseBlockedForPatterns(patternsRaw);
  }
  return patterns;
}
