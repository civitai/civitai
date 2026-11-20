import type { ManipulateType } from 'dayjs';
import dayjs from '~/shared/utils/dayjs';
import type { MediaFilterKey } from '~/components/Image/Filters/media-filter-keys';
import type { ImagesQueryParamSchema } from '~/components/Image/image-query-params';
import { ImageSort } from '~/server/common/enums';
import type { SemanticImageSearchInput } from '~/server/schema/semantic-image-search.schema';
import {
  MAX_SEARCH_MODEL_VERSIONS,
  SEMANTIC_QUERY_MAX_LENGTH,
} from '~/server/schema/semantic-image-search.schema';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { QS } from '~/utils/qs';

// React-free: the /search/images redirect reads it on the server.

// The feed filters the search index cannot apply. While a query is set they are shown greyed and
// ignored, never sent: the index ranks by meaning and carries no tools, techniques, remix or meta
// fields, and the viewer-only views (hidden, followed, own drafts) are not in it. Made on-site and
// Metadata only are applied when hydrating instead.
export const imageFeedSearchUnavailableKeys = [
  'requiringMeta',
  'hidden',
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

export const imageFeedFilterLabels: Record<
  (typeof imageFeedSearchUnavailableKeys)[number] | 'followed' | 'newCreators',
  string
> = {
  // As the Filters menu and the Followed button word them, so a greyed control reads the same.
  requiringMeta: 'Requiring Metadata',
  hidden: 'Hidden',
  scheduled: 'Scheduled',
  remixesOnly: 'Remixes Only',
  nonRemixesOnly: 'Originals Only',
  hideChallenges: 'Hide challenge entries',
  hideManualResources: 'Hide manually-added',
  hideAutoResources: 'Hide auto-detected',
  poiOnly: 'POI',
  minorOnly: 'Minor',
  disablePoi: 'Disable POI',
  disableMinor: 'Disable Minor',
  notPublished: 'Not Published',
  tools: 'Tools',
  techniques: 'Techniques',
  hatTeams: 'Teams',
  hatTurfMine: 'My live hats',
  hideTurfHats: 'Turf hats',
  hideWornHats: 'Worn hats',
  followed: 'Followed',
  newCreators: 'New & Upcoming',
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
  const keys = [...imageFeedSearchUnavailableKeys, 'followed', 'newCreators'] as const;
  return keys.filter((key) => isActive(filters[key]));
}

export type ImageFeedSearchSort = 'newest';

/** The feed's `?searchSort=`: Newest, or undefined for the search's own Best match order. */
export function parseFeedSearchSort(value: unknown): ImageFeedSearchSort | undefined {
  return value === 'newest' ? value : undefined;
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

/**
 * A search starts over all time rather than the feed's saved period (Week by default), which would
 * hide most matches. A period picked during the search stays; the feed gets its saved period back
 * the next time it renders without a search (cleared, or a later visit after leaving mid-search),
 * unless one was picked meanwhile. `savedPeriod` is persisted, so a reload mid-search neither resets
 * a picked period nor loses the one to give back. `write` is what the store's period becomes;
 * null when nothing changes.
 */
export function searchPeriodChange({
  searching,
  wasSearching,
  period,
  savedPeriod,
}: {
  searching: boolean;
  wasSearching: boolean;
  period: MetricTimeframe | undefined;
  savedPeriod: MetricTimeframe | undefined;
}): { write?: MetricTimeframe; savedPeriod: MetricTimeframe | undefined } | null {
  if (searching) {
    if (wasSearching || savedPeriod || !period || period === MetricTimeframe.AllTime) return null;
    return { write: MetricTimeframe.AllTime, savedPeriod: period };
  }
  if (!savedPeriod) return null;
  return (period ?? MetricTimeframe.AllTime) === MetricTimeframe.AllTime
    ? { write: savedPeriod, savedPeriod: undefined }
    : { savedPeriod: undefined };
}

/** The `?excludeOwn=` toggle of a "more like this" search. */
export const parseExcludeOwn = (value: unknown) => value === 'true';

/** The `?modelVersionIds=` the search narrows to: positive ids, distinct, at most the input takes. */
export function parseModelVersionIds(value: unknown) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const ids = raw.map(Number).filter((id) => Number.isInteger(id) && id > 0);
  return [...new Set(ids)].slice(0, MAX_SEARCH_MODEL_VERSIONS);
}

/** The `?similarTo=` image id, when it is one. */
export function parseSimilarTo(value: unknown) {
  const id = Number(first(value as string | string[] | undefined));
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

/**
 * The feed's filters as a semantic image search: only what the index can apply. A query searches by
 * text; without one, `imageId` searches for images like that one ("more like this").
 */
export function toSemanticImageSearchInput({
  query,
  imageId,
  filters,
  browsingLevel,
  sort,
  excludeOwn,
  modelVersionIds,
  now,
}: {
  query?: string;
  imageId?: number;
  /** Images made with any of these versions (behind `imageSearchResources`, decided by the caller). */
  modelVersionIds?: number[];
  /** "More like this" without the viewer's own images. */
  excludeOwn?: boolean;
  filters: FeedFilters;
  browsingLevel: number;
  sort?: ImageFeedSearchSort;
  now?: Date;
}): SemanticImageSearchInput {
  return {
    query: query || undefined,
    imageId: query ? undefined : imageId,
    excludeOwn: !query && imageId && excludeOwn ? true : undefined,
    browsingLevel,
    tagIds: filters.tags?.length ? filters.tags : undefined,
    excludedTagIds: filters.excludedTagIds?.length ? filters.excludedTagIds : undefined,
    baseModels: filters.baseModels?.length ? filters.baseModels : undefined,
    modelVersionIds: modelVersionIds?.length ? modelVersionIds : undefined,
    types: filters.types?.length ? filters.types : undefined,
    usernames: filters.username ? [filters.username] : undefined,
    userIds: filters.userId ? [filters.userId] : undefined,
    postedAfter: periodStart(filters.period, now),
    // "More like this" is always in similarity order.
    sort: query ? sort : undefined,
    fromPlatform: filters.fromPlatform || undefined,
    withMeta: filters.withMeta || undefined,
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

export const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;
export const all = (value: string | string[] | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/**
 * Where an old `/search/images` URL lands now: the images feed with the query applied. Tag names are
 * resolved by `resolveTags` (at most 20, the search's own cap); a name that matches no tag stays in
 * the query as a word, as `#tag` words do in the search bar, so the redirect never widens the search
 * by dropping it. A sort only survives without a query; with one the feed ranks by match. A
 * `similarTo` ("more like this") is carried over; the feed ignores it once a query is typed.
 */
export async function imageFeedUrlFromLegacySearch(
  params: Record<string, string | string[] | undefined>,
  resolveTags: (names: string[]) => Promise<{ id: number; name: string }[]>
) {
  const tagNames = all(params.tags).filter(Boolean).slice(0, 20);
  const tags = tagNames.length ? await resolveTags(tagNames) : [];
  const known = new Set(tags.map((tag) => tag.name.toLowerCase()));
  const unknownNames = tagNames.filter((name) => !known.has(name.toLowerCase()));
  const query = normalizeFeedQuery(
    [first(params.query), ...unknownNames].filter(Boolean).join(' ')
  );
  const sortBy = first(params.sortBy);
  const similarTo = parseSimilarTo(params.similarTo);
  const sort =
    !query && !similarTo && sortBy
      ? legacyImageSorts.find(([re]) => re.test(sortBy))?.[1]
      : undefined;
  const queryString = QS.stringify({
    query,
    similarTo,
    username: first(params.users),
    baseModels: all(params.baseModel ?? params.baseModels),
    tags: tags.map((tag) => tag.id),
    sort,
  });
  return queryString ? `/images?${queryString}` : '/images';
}
