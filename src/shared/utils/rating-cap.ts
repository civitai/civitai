import { Flags } from '~/shared/utils/flags';

/**
 * Whether a rating may be served under a browsing-level cap: every bit must be inside it, so
 * unrated (0) and mixed ratings that reach above the cap fail closed.
 */
export function isRatingWithinCap(level: unknown, cap: number) {
  const rating = Number(level) || 0;
  return rating !== 0 && Flags.hasFlag(cap, rating);
}
