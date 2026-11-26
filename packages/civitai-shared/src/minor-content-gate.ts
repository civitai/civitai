import { browsingLevels, flagifyBrowsingLevel, NsfwLevel } from './browsing-levels';

/**
 * The one statement of when content tied to a minor is restricted: a minor-flagged image, a model,
 * storyline or remix host flagged as depicting a minor, or a scan that found one. Every gate that
 * hides, caps, refuses or keeps such content flagged asks here, so they cannot disagree.
 *
 * Today the rule is the content's maturity rating: mature ratings are restricted. A rating that is
 * missing (null/undefined) or unrated (0) counts as restricted, never as safe. `nsfwLevel` may be a
 * single rating or a mask of ratings; a mask is restricted when any rating in it is.
 *
 * Gates that clear a minor flag (the minor review queue's Accept) are permissive and do not use this.
 */
export function isMinorRestrictedLevel(nsfwLevel: number | null | undefined): boolean {
  return nsfwLevel == null || nsfwLevel === 0 || nsfwLevel >= NsfwLevel.R;
}

export function isMinorContentRestricted(content: {
  minor: boolean;
  nsfwLevel: number | null | undefined;
}): boolean {
  return content.minor && isMinorRestrictedLevel(content.nsfwLevel);
}

const minorAllowedLevels = browsingLevels.filter((level) => !isMinorRestrictedLevel(level));

/**
 * The highest single rating content tied to a minor may carry; the ceiling form of the rule. It
 * covers rated levels only: an unrated (0) rating passes a `<=` compare against it, so a gate that
 * caps by this ceiling must refuse unrated content on its own, as the remix and storyline gates do.
 */
export const MINOR_CONTENT_MAX_LEVEL: number = Math.max(...minorAllowedLevels);

/** The browsing levels content tied to a minor may be shown at; the flag form of the rule. */
export const minorContentBrowsingLevelsFlag = flagifyBrowsingLevel(minorAllowedLevels);
