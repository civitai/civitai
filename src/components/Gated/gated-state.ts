import {
  hasPublicBrowsingLevel,
  hasSafeBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';

/**
 * Which view `Gated` will render given the current request.
 *
 *   - `loading`  — session is still resolving for above-PG content; render nothing yet
 *   - `page`     — full content visible (children render). May be a verified-bot
 *                  bypass of an otherwise-gated page; check `isPaywalled` to know
 *   - `unrated`  — content hasn't been moderation-rated yet (SFW site only)
 *   - `login`    — login required (PG13 on SFW or non-safe on .red, logged-out)
 *   - `redirect` — content moved to civitai.red, redirect prompt shown
 */
export type GatedState = 'loading' | 'page' | 'unrated' | 'login' | 'redirect';

export interface UseGatedResult {
  state: GatedState;
  /**
   * True when `state === 'page'` only because a verified search-engine
   * crawler bypassed what would have otherwise been a login gate. Triggers
   * paywall structured-data augmentation in `Gated` and the `.paywalled-content`
   * wrapper around children.
   */
  isPaywalled: boolean;
}

export type GatedDecisionInput = {
  contentNsfwLevel: number;
  nsfw?: boolean;
  bypassRating?: boolean;
  /** `features.canViewNsfw` — true on the `.red` site. */
  canViewNsfw: boolean;
  /** A signed-in viewer (`useCurrentUser()` non-null). */
  signedIn: boolean;
  /** The session is still resolving and no cached session data exists. */
  sessionLoading: boolean;
  verifiedBot: boolean;
};

/** `useGated`'s decision with its inputs passed in rather than read from providers. */
export function decideGatedState({
  contentNsfwLevel,
  nsfw,
  bypassRating,
  canViewNsfw,
  signedIn,
  sessionLoading,
  verifiedBot,
}: GatedDecisionInput): UseGatedResult {
  // PG13 waits too: deciding it while loading shows `login` to a viewer who may be signed in.
  if (!hasPublicBrowsingLevel(contentNsfwLevel) && sessionLoading) {
    return { state: 'loading', isPaywalled: false };
  }

  // `bypassRating`: owners/mods preview their own unrated drafts before publishing.
  if (!canViewNsfw && contentNsfwLevel === 0 && !bypassRating) {
    return { state: 'unrated', isPaywalled: false };
  }

  const isUnratedOwnerPreview = bypassRating && contentNsfwLevel === 0;
  const isPG13Only =
    hasSafeBrowsingLevel(contentNsfwLevel) && !hasPublicBrowsingLevel(contentNsfwLevel);

  if (!canViewNsfw && !signedIn && !nsfw && isPG13Only && !isUnratedOwnerPreview) {
    return { state: 'login', isPaywalled: false };
  }

  const meetsAllowedLevel = signedIn
    ? hasSafeBrowsingLevel(contentNsfwLevel)
    : hasPublicBrowsingLevel(contentNsfwLevel);

  if (!canViewNsfw && (nsfw || !meetsAllowedLevel) && !isUnratedOwnerPreview) {
    return { state: 'redirect', isPaywalled: false };
  }

  // Verified bots see the page with paywall structured data, so the URL stays indexable.
  if (!signedIn && !hasPublicBrowsingLevel(contentNsfwLevel)) {
    if (verifiedBot) return { state: 'page', isPaywalled: true };
    return { state: 'login', isPaywalled: false };
  }

  return { state: 'page', isPaywalled: false };
}
