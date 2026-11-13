import { traceContextHeaders } from '~/server/utils/otel-helpers';
import { encodeFeedCursor, parseFeedCursor } from '~/server/common/feed-cursor';
import { HUB_COLLECTION_SOURCES_ENABLED } from '~/server/schema/user-hub.schema';
import { resolveJumpTo } from '~/shared/utils/jump-to-month';
import type { CapturableSearchInput } from '~/server/services/feed-request-capture.service';

export const MAX_OFFSET = 20_000;
export const DEEP_OFFSET = `offset>${MAX_OFFSET}`;
export const CURSOR_UNPARSED = 'cursor:unparsed';
const SORTS: Record<string, string> = {
  'Most Reactions': 'reactions',
  'Most Collected': 'collected',
  'Most Comments': 'comments',
  Newest: 'newest',
  Oldest: 'oldest',
};
const PERIOD_DAYS: Record<string, number | undefined> = {
  Day: 1,
  Week: 7,
  Month: 30,
  Year: 365,
  AllTime: undefined,
};
const LEVELS = [1, 2, 4, 8, 16, 32];
// The feed refuses a cursor id past int4, and a refused jump would fall back unbounded.
const MAX_FEED_ID = 2_147_483_647;
// The feed service's own ceiling on userIds.
const MAX_USER_IDS = 10_000;
const MAX_FOLLOWED = MAX_USER_IDS;
// The feed service's ceilings on a hub's sources and keep-out lists.
const MAX_HUB = {
  users: 50,
  versions: 750,
  tagGroups: 50,
  tagsPerGroup: 50,
  excludedTagGroups: 20,
};
// Filters the candidate has no dimension for; the app resolves the server-side lists
// (hidden) inside the search functions, out of this hook's reach.
const UNSUPPORTED_KEYS = [
  'collectionId',
  'collectionTagId',
  'reviewId',
  'prioritizedUserIds',
  'imageId',
  'generation',
  'reactions',
  'blockedFor',
  'remixOfId',
] as const;
const UNSUPPORTED_FLAGS = [
  'hidden',
  'requiringMeta',
  'pending',
  'publishedOnly',
  'remixesOnly',
  'nonRemixesOnly',
] as const;

const present = (v: unknown) =>
  !(
    v === undefined ||
    v === null ||
    v === false ||
    v === 0 ||
    v === '' ||
    (Array.isArray(v) && v.length === 0)
  );
const ints = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n > 0) : [];
// An inclusion list whose ids are all impossible (prod sends `tags: [0]`) matches
// nothing in Meili. Dropping them silently would widen the query to the whole feed,
// so the request is left to Meili instead.
const emptied = (v: unknown) => Array.isArray(v) && v.length > 0 && ints(v).length === 0;

export type FeedQueryMapping = { ok: true; query: string } | { ok: false; reason: string };
export type FeedQueryMode = 'shadow' | 'primary';
/** Who is asking: the site's own pages, or the public API. A few shapes are served only to one. */
export type FeedQueryCaller = 'website' | 'rest';
const MAX_POST_IDS = 50;
// The feed answers at most this many rows a page.
export const FEED_MAX_LIMIT = 200;

export { encodeFeedCursor, parseFeedCursor };

/** The candidate's query for a search input, or the first reason it cannot be expressed. */
export function mapSearchInputToFeedQuery(
  input: CapturableSearchInput,
  mode: FeedQueryMode = 'shadow',
  caller: FeedQueryCaller = 'website'
): FeedQueryMapping {
  const skip = (reason: string): FeedQueryMapping => ({ ok: false, reason });
  for (const key of UNSUPPORTED_KEYS) if (present(input[key])) return skip(`input:${key}`);
  for (const flag of UNSUPPORTED_FLAGS) if (input[flag] === true) return skip(`flag:${flag}`);
  // A post's media. The site's own post page shows the author's order, which the feed cannot
  // give (the mirror has no Image.index), and the website already serves it from Postgres; the
  // public API sorts a post's page like any other, as the search index did, and asks for one
  // post 150k times a day. The gallery's post completion takes the requested sort too, and
  // without this sent 10-15 requests a second to the search index from site 5.1.344 on.
  const postIds = ints([
    ...(Array.isArray(input.postIds) ? input.postIds : []),
    ...(present(input.postId) ? [Number(input.postId)] : []),
  ]);
  if (postIds.length) {
    const inRequestedSort = caller === 'rest' || input.postIdsInRequestedSort === true;
    if (!inRequestedSort) return skip('input:postId');
    if (postIds.length > MAX_POST_IDS) return skip(`postIds>${MAX_POST_IDS}`);
    // A completion needs every row it asks for; past the feed's page it would come back short
    // without a sign, so it stays on the search index instead.
    if (
      input.postIdsInRequestedSort === true &&
      typeof input.limit === 'number' &&
      input.limit > FEED_MAX_LIMIT
    )
      return skip(`postIds:limit>${FEED_MAX_LIMIT}`);
  }
  // These only narrow a model version's gallery; without one they filter nothing.
  if (present(input.modelVersionId))
    for (const flag of ['hideAutoResources', 'hideManualResources'] as const)
      if (input[flag] === true) return skip(`flag:${flag}`);
  // Signed out, the search path drops the flag and serves the global feed.
  const followedOn = input.followed === true && present(input.currentUserId);
  const followed = followedOn ? input.followedUserIds : undefined;
  if (followedOn) {
    if (!Array.isArray(followed)) return skip('flag:followed');
    if (followed.length > MAX_FOLLOWED) return skip(`followed>${MAX_FOLLOWED}`);
    if (present(input.userId)) return skip('flag:followed:userId');
  }
  const newCreators = input.newCreators === true ? input.newCreatorUserIds : undefined;
  if (input.newCreators === true) {
    if (!Array.isArray(newCreators)) return skip('flag:newCreators');
    if (newCreators.length > MAX_USER_IDS) return skip(`newCreators>${MAX_USER_IDS}`);
    if (present(input.userId) || input.followed === true) return skip('flag:newCreators:userId');
  }

  const hub = present(input.hubId) ? mapHubSources(input) : undefined;
  if (hub && !hub.ok) return skip(hub.reason);

  const sort = SORTS[String(input.sort)];
  if (!sort) return skip(`sort:${String(input.sort || 'none')}`);
  const period = String(input.period ?? 'AllTime');
  if (!(period in PERIOD_DAYS)) return skip(`period:${period}`);
  const mask = typeof input.browsingLevel === 'number' ? input.browsingLevel : 1;
  const levels = LEVELS.filter((l) => (mask & l) !== 0);
  if (!levels.length) return skip('browsingLevel:0');

  for (const key of ['tags', 'ids'] as const) if (emptied(input[key])) return skip(`${key}:none`);
  const tags = ints(input.tags);
  const excludedTags = ints(input.excludedTagIds);
  if (tags.length > 100) return skip('tags>100');
  if (excludedTags.length > 100) return skip('excludedTags>100');
  const types = Array.isArray(input.types) ? input.types.map(String) : [];
  if (types.some((t) => !['image', 'video', 'audio'].includes(t)))
    return skip(`types:${types.join(',')}`);

  let versionIds: number[] | undefined;
  if (present(input.modelVersionId)) versionIds = [Number(input.modelVersionId)];
  else if (present(input.modelId)) return skip('modelId');
  const userId = present(input.userId) ? Number(input.userId) : undefined;
  const visibility =
    input.notPublished === true
      ? 'unpublished'
      : input.scheduled === true
      ? 'scheduled'
      : undefined;
  if (visibility && !userId) return skip(`flag:${visibility}:no-user`);
  // Parsed last: a cursor the feed cannot read is refused, so every reason the request
  // could not be served anyway must come first.
  let offset = 0;
  let before: number | undefined;
  const cursor = input.cursor;
  const feedCursor = parseFeedCursor(cursor);
  if (feedCursor) {
    if (mode !== 'primary') return skip('cursor:feed');
  } else if (typeof cursor === 'string' && cursor) {
    const m = /^(\d{1,12})(?:\|(\d{1,15}))?$/.exec(cursor);
    if (!m) return skip(CURSOR_UNPARSED);
    offset = Number(m[1]);
    if (m[2]) before = Math.floor(Number(m[2]) / 60_000) * 60_000;
  } else if (typeof cursor === 'number' && Number.isInteger(cursor) && cursor >= 0) offset = cursor;
  else if (cursor) return skip(CURSOR_UNPARSED);
  if (typeof input.offset === 'number' && input.offset > 0) offset = Math.max(offset, input.offset);
  if (offset > MAX_OFFSET) return skip(DEEP_OFFSET);
  // A jump is the feed's own keyset cursor placed at the month edge. Once the search index has
  // served a jumped page its offset cursor is only meaningful there, so it keeps the paging.
  let keyset = feedCursor;
  const jump = resolveJumpTo({ jumpTo: input.jumpTo, sort: input.sort, userId });
  if (jump && !feedCursor) {
    if (mode !== 'primary') return skip('jumpTo:shadow');
    if (offset) return skip('jumpTo:offset');
    keyset = jump.direction === 'before' ? `${jump.endMs - 1}|${MAX_FEED_ID}` : `${jump.startMs}|0`;
  }

  const params = new URLSearchParams();
  params.set('levels', levels.join(','));
  if (input.useCombinedNsfwLevel) params.set('combinedLevels', '1');
  if (tags.length) params.set('tags', tags.join(','));
  if (excludedTags.length) params.set('excludedTags', excludedTags.join(','));
  // The hub's own refusals first: the list is cut at the feed's limit, and a hub exclusion lost
  // to the cut is content its owner said to keep out.
  const excludedUsers = [
    ...new Set([...(hub?.excludedUserIds ?? []), ...ints(input.excludedUserIds)]),
  ];
  if (excludedUsers.length) params.set('excludedUserIds', excludedUsers.slice(0, 1000).join(','));
  if (hub) for (const [key, value] of hub.params) params.set(key, value);
  if (versionIds) params.set('versionIds', versionIds.join(','));
  if (userId) params.set('userIds', String(userId));
  const followedIds = ints(followed);
  if (followedIds.length) params.set('userIds', followedIds.join(','));
  const newCreatorIds = ints(newCreators);
  if (newCreatorIds.length) params.set('userIds', newCreatorIds.join(','));
  if (types.length) params.set('types', types.join(','));
  if (input.withMeta === true) params.set('withMeta', '1');
  if (input.fromPlatform === true) params.set('fromPlatform', '1');
  if (input.disableMinor === true) params.set('excludeMinor', '1');
  if (input.disablePoi === true) {
    params.set('excludePoi', '1');
    if (present(input.currentUserId)) params.set('viewerId', String(input.currentUserId));
  }
  const baseModels = Array.isArray(input.baseModels)
    ? input.baseModels.map(String).filter(Boolean)
    : [];
  if (baseModels.length) params.set('baseModels', baseModels.join(','));
  const tools = ints(input.tools);
  if (tools.length) params.set('tools', tools.join(','));
  const techniques = ints(input.techniques);
  if (techniques.length) params.set('techniques', techniques.join(','));
  const ids = ints(input.ids);
  if (ids.length) params.set('ids', ids.slice(0, 200).join(','));
  if (postIds.length) params.set('postIds', [...new Set(postIds)].join(','));
  if (present(input.model3dId)) params.set('model3dIds', String(input.model3dId));
  if (visibility) params.set('visibility', visibility);
  params.set('sort', sort);
  const days = PERIOD_DAYS[period];
  if (days) params.set('periodDays', String(days));
  const limit =
    typeof input.limit === 'number' && input.limit > 0 ? Math.min(input.limit, 200) : 100;
  params.set('limit', String(limit));
  if (keyset) params.set('cursor', keyset);
  else if (offset) params.set('offset', String(offset));
  // The site freezes a paged set at the first page's minute only for Newest; the other
  // sorts page a live set, so a cut there would compare different sets.
  if (before && sort === 'newest') params.set('before', String(before));
  return { ok: true, query: params.toString() };
}

type HubMapping =
  | { ok: true; params: [string, string][]; excludedUserIds: number[] }
  | { ok: false; reason: string };

const tagGroupsParam = (groups: number[][]) => groups.map((g) => g.join(',')).join(';');

/**
 * A hub as the feed's any-of sources and keep-out lists. Anything that would send the request
 * without a source, or with fewer exclusions than the hub holds, is refused instead: the first
 * is the open feed served as someone's hub, the second is content the owner kept out.
 */
function mapHubSources(input: CapturableSearchInput): HubMapping {
  const skip = (reason: string): HubMapping => ({ ok: false, reason });
  const sources = input.hubSources;
  if (!sources) return skip('input:hubId');
  // The feed takes one driver: a hub's sources, or a creator, an id list or a gallery.
  if (
    present(input.userId) ||
    input.followed === true ||
    input.newCreators === true ||
    present(input.ids) ||
    present(input.postId) ||
    present(input.postIds) ||
    present(input.model3dId)
  )
    return skip('hub:driver');
  if (HUB_COLLECTION_SOURCES_ENABLED && sources.collectionIds.length)
    return skip('hub:collections');

  const whole = (list: number[]) => ints(list).length === list.length;
  const groupsWhole = (groups: number[][]) => groups.every((g) => g.length > 0 && whole(g));
  const { userIds, modelVersionIds, tagGroups, excluded } = sources;
  if (
    !whole(userIds) ||
    !whole(modelVersionIds) ||
    !groupsWhole(tagGroups) ||
    !whole(excluded.userIds) ||
    !whole(excluded.modelVersionIds) ||
    !groupsWhole(excluded.tagGroups)
  )
    return skip('hub:ids');
  if (!userIds.length && !modelVersionIds.length && !tagGroups.length) return skip('hub:none');

  // The feed keeps a version's three attributions as one list, so it cannot leave one out.
  if (modelVersionIds.length)
    for (const flag of ['hideAutoResources', 'hideManualResources'] as const)
      if (input[flag] === true) return skip(`flag:${flag}`);

  if (userIds.length > MAX_HUB.users) return skip(`hub:users>${MAX_HUB.users}`);
  if (modelVersionIds.length > MAX_HUB.versions) return skip(`hub:versions>${MAX_HUB.versions}`);
  if (tagGroups.length > MAX_HUB.tagGroups) return skip(`hub:tagGroups>${MAX_HUB.tagGroups}`);
  if (excluded.modelVersionIds.length > MAX_HUB.versions)
    return skip(`hub:excludedVersions>${MAX_HUB.versions}`);
  if (excluded.tagGroups.length > MAX_HUB.excludedTagGroups)
    return skip(`hub:excludedTagGroups>${MAX_HUB.excludedTagGroups}`);
  if ([...tagGroups, ...excluded.tagGroups].some((g) => g.length > MAX_HUB.tagsPerGroup))
    return skip(`hub:tagsPerGroup>${MAX_HUB.tagsPerGroup}`);

  const params: [string, string][] = [];
  if (userIds.length) params.push(['anyUserIds', userIds.join(',')]);
  if (modelVersionIds.length) params.push(['anyVersionIds', modelVersionIds.join(',')]);
  if (tagGroups.length) params.push(['anyTagGroups', tagGroupsParam(tagGroups)]);
  if (excluded.modelVersionIds.length)
    params.push(['excludedVersionIds', excluded.modelVersionIds.join(',')]);
  if (excluded.tagGroups.length)
    params.push(['excludedTagGroups', tagGroupsParam(excluded.tagGroups)]);
  return { ok: true, params, excludedUserIds: excluded.userIds };
}

export type FeedAnswer = {
  nextCursor?: string;
  status: number;
  ms: number;
  ids: number[];
  /** The feed's reason for a 400, so a request the mapper thought fine can be read back. */
  error?: string;
  route?: string;
  estimate?: number;
  candidates?: number;
};

export async function fetchFeedAnswer(
  baseUrl: string,
  query: string,
  timeoutMs: number,
  source: FeedQueryMode = 'shadow'
): Promise<FeedAnswer> {
  const started = Date.now();
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/feed?${query}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { ...traceContextHeaders(), 'x-request-source': source },
  });
  const ms = Date.now() - started;
  if (!res.ok) {
    let error: string | undefined;
    if (res.status === 400) error = (await res.text().catch(() => '')).slice(0, 600) || undefined;
    return { status: res.status, ms, ids: [], error };
  }
  const body = (await res.json()) as {
    items?: number[];
    nextCursor?: string;
    route?: string;
    estimate?: number;
    candidates?: number;
  };
  return {
    status: res.status,
    ms,
    ids: ints(body.items),
    nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : undefined,
    route: body.route,
    estimate: body.estimate,
    candidates: body.candidates,
  };
}
