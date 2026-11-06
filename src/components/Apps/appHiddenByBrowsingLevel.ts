import { offsiteContentRatingLabel } from '~/shared/constants/browsingLevel.constants';
import type { HiddenMatureRating } from '~/server/services/blocks/app-listing-store-gate';
import { getLoginLink } from '~/utils/login-helpers';

/**
 * The hidden state an R/X app shows, on its detail page and its run page, to a viewer whose
 * browsing level excludes that rating (on a mature-capable site; elsewhere a mature app is simply
 * not there). It replaces a 404 so the viewer is told why, and carries nothing of the app but its
 * rating: no name, description, cover or screenshots.
 *
 * Owners and moderators get it too — they can change their own browsing level like anyone else.
 */

/** Where a signed-in viewer changes their browsing level (the account page's Content section). */
export const CONTENT_SETTINGS_HREF = '/user/account/content';

export type AppHiddenByBrowsingLevelCopy = {
  title: string;
  body: string;
  action: { label: string; href: string };
};

/** The words and the one action of the hidden state. Exported so tests pin the exact copy. */
export function appHiddenByBrowsingLevelCopy(args: {
  contentRating: HiddenMatureRating;
  signedIn: boolean;
  /** Where a sign-in returns to: the page the viewer is on. */
  returnUrl: string;
}): AppHiddenByBrowsingLevelCopy {
  const label = offsiteContentRatingLabel(args.contentRating);
  const title = 'Hidden by your browsing settings';
  if (!args.signedIn) {
    return {
      title,
      body: `This app is rated ${label}. Sign in and enable mature content in your browsing settings to see it.`,
      action: {
        label: 'Sign in',
        href: getLoginLink({ returnUrl: args.returnUrl, reason: 'view-content' }),
      },
    };
  }
  return {
    title,
    body: `This app is rated ${label}, and your browsing level doesn't include ${label} content. To see it, turn on ${label} in your Content & Browsing settings.`,
    action: { label: 'Open Content & Browsing settings', href: CONTENT_SETTINGS_HREF },
  };
}

export type StorePreviewView<D> =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'hidden'; contentRating: HiddenMatureRating }
  | { kind: 'detail'; detail: D };

/**
 * What the app detail page (`/apps/store-preview/<slug>`) renders. The detail read 404s for an
 * R/X app the viewer may not see (so none of it is sent); the page then asks
 * `appListings.getAppHiddenState` why, and renders the hidden state when that names a rating —
 * otherwise the ordinary NotFound.
 */
export function storePreviewView<D>(args: {
  canSeeStore: boolean;
  detail: D | undefined;
  detailError: unknown;
  detailLoading: boolean;
  /** `undefined` = not asked yet / in flight; `null` = nothing hidden. */
  hidden: { contentRating: HiddenMatureRating } | null | undefined;
  hiddenLoading: boolean;
}): StorePreviewView<D> {
  if (!args.canSeeStore) return { kind: 'not-found' };
  if (args.detail) return { kind: 'detail', detail: args.detail };
  if (args.detailLoading) return { kind: 'loading' };
  if (args.hidden) return { kind: 'hidden', contentRating: args.hidden.contentRating };
  if (args.detailError && args.hiddenLoading) return { kind: 'loading' };
  return { kind: 'not-found' };
}
