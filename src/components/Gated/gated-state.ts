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

/**
 * `useGated`'s decision with its inputs passed in rather than read from providers. Pure, and
 * free of React, so code outside the component tree (the image page's preload,
 * `~/components/Image/DetailV2/image-detail-main-media`) asks the same question the gate does.
 */
export function decideGatedState({
  contentNsfwLevel,
  nsfw,
  bypassRating,
  canViewNsfw,
  signedIn,
  sessionLoading,
  verifiedBot,
}: GatedDecisionInput): UseGatedResult {
  // Defer the decision while session is loading and we have no cached data — for anything a
  // signed-out viewer could be gated from, i.e. everything above PG. PG13 included: deciding it
  // while loading is `login` on either site, shown to a viewer who may well be signed in.
  if (!hasPublicBrowsingLevel(contentNsfwLevel) && sessionLoading) {
    return { state: 'loading', isPaywalled: false };
  }

  // Unrated content — only block on the SFW site. Owners/mods bypass so
  // they can preview their own drafts before publishing.
  if (!canViewNsfw && contentNsfwLevel === 0 && !bypassRating) {
    return { state: 'unrated', isPaywalled: false };
  }

  const isUnratedOwnerPreview = bypassRating && contentNsfwLevel === 0;
  const isPG13Only =
    hasSafeBrowsingLevel(contentNsfwLevel) && !hasPublicBrowsingLevel(contentNsfwLevel);

  // PG13 on the SFW site requires login. Verified bots aren't a special
  // case here — civitai.com is strictly SFW even for crawlers, so a bot
  // hitting a PG13 page sees the same login gate any anonymous user would.
  if (!canViewNsfw && !signedIn && !nsfw && isPG13Only && !isUnratedOwnerPreview) {
    return { state: 'login', isPaywalled: false };
  }

  const meetsAllowedLevel = signedIn
    ? hasSafeBrowsingLevel(contentNsfwLevel)
    : hasPublicBrowsingLevel(contentNsfwLevel);

  // SFW site, NSFW content — redirect to civitai.red.
  if (!canViewNsfw && (nsfw || !meetsAllowedLevel) && !isUnratedOwnerPreview) {
    return { state: 'redirect', isPaywalled: false };
  }

  // Logged-out browsing is PG-only across both sites. On civitai.red this
  // catches PG13+ (the SFW site already redirected NSFW via `meetsAllowedLevel`
  // and gated PG13 via the `isPG13Only` branch above). Verified bots bypass:
  // they see the page with paywall structured data so the URL is indexable.
  // Humans get the login gate.
  if (!signedIn && !hasPublicBrowsingLevel(contentNsfwLevel)) {
    if (verifiedBot) return { state: 'page', isPaywalled: true };
    return { state: 'login', isPaywalled: false };
  }

  return { state: 'page', isPaywalled: false };
}
