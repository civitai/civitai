import type { SearchIndexKey } from '~/components/Search/search.types';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

/**
 * The search target a dropdown should DEFAULT to, given where it was derived from (the URL
 * section, or a caller's starting index).
 *
 * While image search is off (`imageSearch`), an `images` default lands the user on a target that
 * can only show a maintenance notice, so it resolves to `models` instead. Every other target, and
 * `images` while image search is on, passes through unchanged.
 *
 * This decides only the DEFAULT. Picking Images explicitly from a selector still selects it, and
 * the caller still shows its maintenance notice for that pick — do not route a user's own choice
 * through here.
 *
 * `supported`, when given, is the set the caller is limited to: `models` is substituted only when
 * it is in that set, so a caller that cannot search models keeps its own target (and its notice)
 * rather than being moved onto an index it never declared.
 */
export function resolveSearchTarget(
  target: SearchIndexKey,
  features: Pick<FeatureAccess, 'imageSearch'>,
  supported?: readonly SearchIndexKey[]
): SearchIndexKey {
  if (target !== 'images' || features.imageSearch) return target;
  if (supported && !supported.includes('models')) return target;
  return 'models';
}

type ImageSearchFlags = Partial<Pick<FeatureAccess, 'imageSearch' | 'feedSearch'>>;
type FeedSearchFlags = Partial<
  Pick<FeatureAccess, 'feedSearch' | 'modelFeedSearch' | 'articleFeedSearch' | 'servicesFeedSearch'>
>;

/**
 * Images can be searched: on the search pages (`imageSearch`) or on the images feed (`feedSearch`).
 * `feedSearch` alone is enough, so a rollout of it moves people to the new search.
 */
export const offersImageSearch = (features: ImageSearchFlags) =>
  !!features.imageSearch || !!features.feedSearch;

// The feeds that answer `?query=` themselves, each behind its own flag.
const FEED_SEARCH = {
  images: { flag: 'feedSearch', pathname: '/images' },
  models: { flag: 'modelFeedSearch', pathname: '/models' },
  articles: { flag: 'articleFeedSearch', pathname: '/articles' },
} as const satisfies Partial<
  Record<SearchIndexKey, { flag: keyof FeedSearchFlags; pathname: string }>
>;

/** The feed a search on `index` lands on, when that feed answers `?query=` for this viewer. */
export function feedSearchPathname(features: FeedSearchFlags, index: SearchIndexKey) {
  const feed = FEED_SEARCH[index as keyof typeof FEED_SEARCH];
  return feed && features[feed.flag] ? feed.pathname : undefined;
}

// Feeds with no search index of their own. The bar's target there is the default it falls back to
// (`models`), so only that target filters the feed; picking another one still searches it.
const INDEXLESS_FEED_SEARCH = {
  '/services': 'servicesFeedSearch',
} as const satisfies Record<string, keyof FeedSearchFlags>;

/** The header bar filters the feed it is on in place, rather than opening a search page. */
export const searchesFeedInPlace = (
  features: FeedSearchFlags,
  index: SearchIndexKey,
  pathname: string
) => {
  if (feedSearchPathname(features, index) === pathname) return true;
  const flag = INDEXLESS_FEED_SEARCH[pathname as keyof typeof INDEXLESS_FEED_SEARCH];
  return !!flag && !!features[flag] && index === 'models';
};

/** Where /search/images sends a viewer: the images feed, the models search, or nowhere (it stays). */
export function legacyImageSearchDestination(
  features: ImageSearchFlags
): 'images-feed' | 'models-search' | undefined {
  if (features.feedSearch) return 'images-feed';
  if (!features.imageSearch) return 'models-search';
  return undefined;
}
