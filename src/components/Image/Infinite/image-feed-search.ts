import type { ManipulateType } from 'dayjs';
import dayjs from '~/shared/utils/dayjs';
import type { MediaFilterKey } from '~/components/Image/Filters/media-filter-keys';
import type { ImagesQueryParamSchema } from '~/components/Image/image-query-params';
import { ImageSort } from '~/server/common/enums';
import type { SemanticImageSearchInput } from '~/server/schema/semantic-image-search.schema';
import { SEMANTIC_QUERY_MAX_LENGTH } from '~/server/schema/semantic-image-search.schema';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { QS } from '~/utils/qs';

// React-free: the /search/images redirect reads it on the server.

// The feed filters the search index cannot apply. While a query is set they are shown greyed and
// ignored, never sent: the index ranks by meaning and carries no tools, techniques, remix or meta
// fields, and the viewer-only views (hidden, followed, own drafts) are not in it.
export const imageFeedSearchUnavailableKeys = [
  'withMeta',
  'requiringMeta',
  'hidden',
  'fromPlatform',
  'scheduled',
  'remixesOnly',
  'nonRemixesOnly',
  'hideChallenges',
  'hideManualResources',
  'hideAutoResources',
  'poiOnly',
  'minorOnly',
  'disablePoi',
  'disableMinor',
  'notPublished',
  'tools',
  'techniques',
  'hatTeams',
  'hatTurfMine',
  'hideTurfHats',
  'hideWornHats',
] as const satisfies readonly MediaFilterKey[];

export const IMAGE_FEED_SEARCH_UNAVAILABLE_REASON =
  'Search ranks images by what they show, so these filters only work on the feed without a query.';

export const imageFeedFilterLabels: Record<MediaFilterKey | 'followed', string> = {
  period: 'Time period',
  types: 'Media type',
  includePG13: 'Include PG-13',
  withMeta: 'Metadata only',
  requiringMeta: 'Missing metadata',
  hidden: 'Hidden',
  fromPlatform: 'Made on-site',
  scheduled: 'Scheduled',
  remixesOnly: 'Remixes only',
  nonRemixesOnly: 'Originals only',
  hideChallenges: 'Hide challenge entries',
  hideManualResources: 'Hide manual resources',
  hideAutoResources: 'Hide auto resources',
  poiOnly: 'POI only',
  minorOnly: 'Minor only',
  disablePoi: 'Disable POI',
  disableMinor: 'Disable minor',
  notPublished: 'Not published',
  baseModels: 'Base model',
  tools: 'Tools',
  techniques: 'Techniques',
  hatTeams: 'Hat Turf teams',
  hatTurfMine: 'My hats',
  hideTurfHats: 'Hide Turf hats',
  hideWornHats: 'Hide worn hats',
  followed: 'Followed only',
};

type FeedFilters = Partial<
  Omit<ImagesQueryParamSchema, 'tools' | 'techniques'> & {
    tools: number[];
    techniques: number[];
    excludedTagIds: number[];
    hatTeams: unknown[];
    hatTurfMine: boolean;
    hideTurfHats: boolean;
    hideWornHats: boolean;
  }
>;

const isActive = (value: unknown) =>
  Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false;

/** The unavailable filters that are switched on, so the feed can say they are being ignored. */
export function ignoredWhileSearching(filters: FeedFilters) {
  const keys = [...imageFeedSearchUnavailableKeys, 'followed'] as const;
  return keys.filter((key) => isActive(filters[key]));
}

export function normalizeFeedQuery(query: string | undefined) {
  const text = query?.replace(/\s+/g, ' ').trim().slice(0, SEMANTIC_QUERY_MAX_LENGTH);
  return text || undefined;
}

// Truncated to the hour so the search's query key, which carries it, holds still between renders.
export function periodStart(period: MetricTimeframe | undefined, now = new Date()) {
  if (!period || period === MetricTimeframe.AllTime) return undefined;
  return dayjs(now)
    .startOf('hour')
    .subtract(1, period.toLowerCase() as ManipulateType)
    .toDate();
}

/** The feed's filters as a semantic image search: only what the index can apply. */
export function toSemanticImageSearchInput({
  query,
  filters,
  browsingLevel,
  now,
}: {
  query: string;
  filters: FeedFilters;
  browsingLevel: number;
  now?: Date;
}): SemanticImageSearchInput {
  return {
    query,
    browsingLevel,
    tagIds: filters.tags?.length ? filters.tags : undefined,
    excludedTagIds: filters.excludedTagIds?.length ? filters.excludedTagIds : undefined,
    baseModels: filters.baseModels?.length ? filters.baseModels : undefined,
    types: filters.types?.length ? filters.types : undefined,
    usernames: filters.username ? [filters.username] : undefined,
    postedAfter: periodStart(filters.period, now),
    limit: 50,
  };
}

// The `sortBy` values the retired image search page wrote, by the metric each one ranked on.
const legacyImageSorts: [RegExp, ImageSort][] = [
  [/createdAt:asc/i, ImageSort.Oldest],
  [/createdAt/i, ImageSort.Newest],
  [/reactionCount/i, ImageSort.MostReactions],
  [/commentCount/i, ImageSort.MostComments],
  [/collectedCount/i, ImageSort.MostCollected],
];

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const all = (value: string | string[] | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/**
 * Where an old `/search/images` URL lands now: the images feed with the query applied. Tag names
 * are resolved by the caller (`tagIds`). A sort only survives without a query; with one the feed
 * ranks by match.
 */
export function imageFeedUrlFromLegacySearch(
  params: Record<string, string | string[] | undefined>,
  tagIds: number[] = []
) {
  const query = normalizeFeedQuery(first(params.query));
  const sortBy = first(params.sortBy);
  const sort = !query && sortBy ? legacyImageSorts.find(([re]) => re.test(sortBy))?.[1] : undefined;
  const queryString = QS.stringify({
    query,
    username: first(params.users),
    baseModels: all(params.baseModel ?? params.baseModels),
    tags: tagIds,
    sort,
  });
  return queryString ? `/images?${queryString}` : '/images';
}
