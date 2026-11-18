import type { SearchIndexKey } from '~/components/Search/search.types';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { postgresSlugify } from '~/utils/string-helpers';

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
  Pick<
    FeatureAccess,
    | 'feedSearch'
    | 'modelFeedSearch'
    | 'articleFeedSearch'
    | 'servicesFeedSearch'
    | 'semanticBountySearch'
  >
>;

/**
 * Images can be searched: on the search pages (`imageSearch`) or on the images feed (`feedSearch`).
 * `feedSearch` alone is enough, so a rollout of it moves people to the new search.
 */
export const offersImageSearch = (features: ImageSearchFlags) =>
  !!features.imageSearch || !!features.feedSearch;

// The feeds that answer `?query=` themselves, each behind its own flag. `profilePathname` is the
// same feed on a creator's profile tab: filtered in place there, but never where a search lands.
const FEED_SEARCH = {
  images: { flag: 'feedSearch', pathname: '/images', profilePathname: '/user/[username]/images' },
  models: {
    flag: 'modelFeedSearch',
    pathname: '/models',
    profilePathname: '/user/[username]/models',
  },
  articles: {
    flag: 'articleFeedSearch',
    pathname: '/articles',
    profilePathname: '/user/[username]/articles',
  },
  bounties: { flag: 'semanticBountySearch', pathname: '/bounties', profilePathname: undefined },
} as const satisfies Partial<
  Record<
    SearchIndexKey,
    { flag: keyof FeedSearchFlags; pathname: string; profilePathname: string | undefined }
  >
>;

/** The feed a search on `index` lands on, when that feed answers `?query=` for this viewer. */
export function feedSearchPathname(features: FeedSearchFlags, index: SearchIndexKey) {
  const feed = FEED_SEARCH[index as keyof typeof FEED_SEARCH];
  return feed && features[feed.flag] ? feed.pathname : undefined;
}

// The profile sections whose feed is the searchable one: published models and articles, the images
// tab's own images. Drafts, private models, training and reactions render other lists.
const SEARCHABLE_PROFILE_SECTIONS: unknown[] = [undefined, 'published', 'images'];

/**
 * The header bar filters the feed it is on in place, rather than opening a search page. `pathname`
 * is the route pattern (`router.pathname`), not the URL path; `section` is a profile's `?section=`.
 */
export function searchesFeedInPlace(
  features: FeedSearchFlags,
  index: SearchIndexKey,
  pathname: string,
  section?: unknown
) {
  // /services has no search index, so there only the bar's default target (`models`) filters it.
  if (pathname === '/services') return !!features.servicesFeedSearch && index === 'models';
  const feed = FEED_SEARCH[index as keyof typeof FEED_SEARCH];
  if (!feed || !features[feed.flag]) return false;
  if (pathname === feed.pathname) return true;
  return pathname === feed.profilePathname && SEARCHABLE_PROFILE_SECTIONS.includes(section);
}

/**
 * The `?section=` a profile tab renders: the profile pages honour it only on the viewer's own
 * profile, so a visitor's `?section=draft` still shows (and searches) the published feed.
 */
export function profileFeedSection(
  query: { username?: unknown; section?: unknown },
  viewerUsername: string | undefined
) {
  const ownProfile =
    !!viewerUsername &&
    typeof query.username === 'string' &&
    postgresSlugify(viewerUsername) === postgresSlugify(query.username);
  return ownProfile ? query.section : undefined;
}

/** A creator's profile tab that the header bar filters in place (its `username` is the route's). */
export const isProfileFeedPathname = (pathname: string) =>
  Object.values(FEED_SEARCH).some((feed) => feed.profilePathname === pathname);

/**
 * The section the header bar's target follows: the first path segment, or on a creator's profile
 * (`/user/<name>/<tab>`) the tab when it is a searchable feed (Models, Images or Articles).
 */
export function searchSectionFromPath(path: string) {
  const [section, username, tab] = path.split('?')[0].split('/').filter(Boolean);
  const isFeedTab = !!tab && tab in FEED_SEARCH;
  return section === 'user' && username && isFeedTab ? tab : section;
}

/** Where /search/images sends a viewer: the images feed, the models search, or nowhere (it stays). */
export function legacyImageSearchDestination(
  features: ImageSearchFlags
): 'images-feed' | 'models-search' | undefined {
  if (features.feedSearch) return 'images-feed';
  if (!features.imageSearch) return 'models-search';
  return undefined;
}

type PageSearchFlags = Partial<
  Pick<
    FeatureAccess,
    'semanticChallengeSearch' | 'semanticCrucibleSearch' | 'servicesFeedSearch' | 'pageSearch'
  >
>;

// Pages outside the search indexes that answer their own `?query=`, each behind a flag: there the
// header bar is a plain search of that page, whatever the page does with the text.
const PAGE_SEARCH: Record<string, { flag: keyof PageSearchFlags; placeholder: string }> = {
  '/challenges': { flag: 'semanticChallengeSearch', placeholder: 'Search challenges' },
  '/crucibles': { flag: 'semanticCrucibleSearch', placeholder: 'Search crucibles' },
  '/services': { flag: 'servicesFeedSearch', placeholder: 'Search services' },
  '/shop': { flag: 'pageSearch', placeholder: 'Search the shop' },
  '/apps/store': { flag: 'pageSearch', placeholder: 'Search apps' },
  '/changelog': { flag: 'pageSearch', placeholder: 'Search updates' },
  // A creator's tabs without a search index: their own feeds filter by text.
  '/user/[username]/posts': { flag: 'pageSearch', placeholder: 'Search their posts' },
  '/user/[username]/collections': { flag: 'pageSearch', placeholder: 'Search their collections' },
};

/**
 * The header bar's search on a page that answers its own `?query=`, or undefined elsewhere.
 * `pathname` is the route pattern (`router.pathname`).
 */
export function pageSearchFor(features: PageSearchFlags, pathname: string) {
  const page = PAGE_SEARCH[pathname];
  return page && features[page.flag] ? { placeholder: page.placeholder } : undefined;
}
