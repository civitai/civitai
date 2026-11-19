import { parseBlockedForPatterns } from '@civitai/shared/review-batch';
import { env } from '$env/dynamic/private';

let patternsRaw: string | undefined;
let patterns: ReturnType<typeof parseBlockedForPatterns> = null;

/** The private `Image.blockedFor` patterns, parsed once per value of the env var. */
export function blockedForPatterns() {
  const raw = env.REVIEW_SHEET_BLOCKEDFOR_PATTERNS;
  if (raw !== patternsRaw) {
    patternsRaw = raw;
    patterns = parseBlockedForPatterns(raw);
  }
  return patterns;
}
