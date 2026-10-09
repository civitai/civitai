import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { registerCounterWithLabels, registerHistogram } from '~/server/prom/client';
import type { CapturableSearchInput } from '~/server/services/feed-request-capture.service';
import {
  CURSOR_UNPARSED,
  DEEP_OFFSET,
  encodeFeedCursor,
  fetchFeedAnswer,
  mapSearchInputToFeedQuery,
  type FeedAnswer,
} from '~/server/services/feed-shadow.service';

export const FEED_PRIMARY_TIMEOUT_MS = 5_000;
const HUB_ROUTES = new Set(['union-walk', 'union-gather', 'empty']);

const requestCounter = registerCounterWithLabels({
  name: 'feed_primary_requests_total',
  help: 'Image-feed searches answered by the feed service instead of Meilisearch, by outcome',
  labelNames: ['outcome', 'reason', 'route'] as const,
});

/** Which caller asked: the site's image feed or the public REST images endpoint. */
export type FeedPrimaryRoute = 'website' | 'rest';

// These three mapping reasons carry request text; the rest are a fixed set.
const UNBOUNDED_REASONS = ['sort', 'period', 'types'];
export function reasonLabel(reason: string) {
  const head = reason.split(':')[0] as string;
  return UNBOUNDED_REASONS.includes(head) ? head : reason;
}
export const countFeedPrimary = (
  outcome: string,
  reason = '',
  route: FeedPrimaryRoute = 'website'
) => requestCounter.inc({ outcome, reason: reasonLabel(reason), route });

const UNMAPPED_LOG_INTERVAL_MS = 60_000;
const unmappedLoggedAt = new Map<string, number>();
function logUnmapped(reason: string, input: CapturableSearchInput) {
  const now = Date.now();
  if (now - (unmappedLoggedAt.get(reason) ?? 0) < UNMAPPED_LOG_INTERVAL_MS) return;
  unmappedLoggedAt.set(reason, now);
  const keys = Object.keys(input).filter((k) => {
    const v = input[k];
    return v !== undefined && v !== null && v !== false && !(Array.isArray(v) && !v.length);
  });
  logToAxiom(
    {
      type: 'warning',
      name: 'feed-primary-unmapped',
      reason,
      keys,
      sort: input.sort,
      period: input.period,
      cursorType: typeof input.cursor,
      cursor: reason === 'cursor:unparsed' ? String(input.cursor).slice(0, 80) : undefined,
    },
    'civitai-prod'
  ).catch(() => undefined);
}

const hydrateDuration = registerHistogram({
  name: 'feed_primary_hydrate_duration_seconds',
  help: 'Time to load the rows of a feed-served page from Postgres',
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

export type FeedPrimaryPage<T> = {
  data: T[];
  nextCursor: string | undefined;
  feedMs: number;
  route?: string;
};
export type FeedPrimaryResult<T> =
  | { ok: true; page: FeedPrimaryPage<T> }
  /** `nextCursor` is set on `hydrate:empty`: the feed's continuation past the emptied page. */
  | { ok: false; reason: string; nextCursor?: string };

export type FeedPrimaryDeps<T extends { id: number }> = {
  fetchFeed: (query: string, timeoutMs: number) => Promise<FeedAnswer>;
  /** Loads the page's records in any order; the feed's order is restored here. */
  hydrate: (ids: number[]) => Promise<T[]>;
  timeoutMs?: number;
  route?: FeedPrimaryRoute;
};

/** The image query for hydrating exactly `ids`: the request's filters without its paging or
 *  period, both already applied by the feed (getAllImages would cut the period on createdAt). */
export function feedHydrateQuery<
  T extends {
    cursor?: unknown;
    skip?: number;
    offset?: number;
    entry?: number;
    limit?: number;
    period?: unknown;
    modelId?: number;
    modelVersionId?: number;
    hubId?: number;
    hubExcludedSources?: unknown;
  }
>(
  input: T,
  ids: number[]
): Omit<
  T,
  | 'cursor'
  | 'skip'
  | 'offset'
  | 'entry'
  | 'period'
  | 'modelId'
  | 'modelVersionId'
  | 'hubId'
  | 'hubExcludedSources'
> & {
  ids: number[];
  limit: number;
  period: 'AllTime';
  throwOnStatementTimeout: true;
} {
  const {
    cursor: _cursor,
    skip: _skip,
    offset: _offset,
    entry: _entry,
    period: _period,
    // The feed already scoped these, and counts a creator's post on a version as a member where
    // the hydrate's resource join would drop it.
    modelId: _modelId,
    modelVersionId: _modelVersionId,
    // The feed already applied the hub, and the database path refuses a hub outright.
    hubId: _hubId,
    hubExcludedSources: _hubExcludedSources,
    ...rest
  } = input;
  // getAllImages would answer a statement timeout with an empty page, which here would read as
  // a page the hydrate filtered out; as an error it is a hydrate:error instead.
  return { ...rest, ids, limit: ids.length, period: 'AllTime', throwOnStatementTimeout: true };
}

/** Truthful subset of the request-path Flipt context (feature-flags.service.ts) built
 *  from what the search input carries, so segments on userId/isModerator can match. */
export function feedFliptContext(input: {
  currentUserId?: number;
  isModerator?: boolean;
}): Record<string, string> {
  if (!input.currentUserId) return { isLoggedIn: 'false' };
  return {
    userId: String(input.currentUserId),
    isModerator: String(!!input.isModerator),
    isLoggedIn: 'true',
  };
}

export async function serveFromFeed<T extends { id: number }>(
  input: CapturableSearchInput,
  deps: FeedPrimaryDeps<T>
): Promise<FeedPrimaryResult<T>> {
  const count = (outcome: string, reason = '') => countFeedPrimary(outcome, reason, deps.route);
  // Meilisearch answers a follow list with no creators as an empty feed, whatever else is set,
  // an unpopulated new-creator board serves nothing rather than the global feed, and so does a
  // hub that resolves to nothing for this viewer.
  if (
    (input.followed === true && input.followedUserIds?.length === 0) ||
    (input.newCreators === true && input.newCreatorUserIds?.length === 0) ||
    (!!input.hubId && input.hubSources === null)
  ) {
    count('served');
    return { ok: true, page: { data: [], nextCursor: undefined, feedMs: 0 } };
  }
  const mapping = mapSearchInputToFeedQuery(input, 'primary');
  if (!mapping.ok) {
    const rejected = mapping.reason === DEEP_OFFSET || mapping.reason === CURSOR_UNPARSED;
    count(rejected ? 'rejected' : 'unmapped', mapping.reason);
    if (mapping.reason !== DEEP_OFFSET) logUnmapped(reasonLabel(mapping.reason), input);
    return { ok: false, reason: mapping.reason };
  }
  let answer: FeedAnswer;
  try {
    answer = await deps.fetchFeed(mapping.query, deps.timeoutMs ?? FEED_PRIMARY_TIMEOUT_MS);
  } catch (e) {
    const name = (e as Error)?.name;
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error';
    count(reason, reason === 'error' ? 'fetch' : '');
    return { ok: false, reason };
  }
  if (answer.status !== 200) {
    count('error', `status:${answer.status}`);
    return { ok: false, reason: `status:${answer.status}` };
  }
  // A feed build without the any-of sources ignores them and answers with the open feed. Only
  // a plan that took the union, or the feed's own empty page, is the hub.
  if (input.hubId && !HUB_ROUTES.has(answer.route ?? '')) {
    count('error', 'hub:route');
    return { ok: false, reason: 'hub:route' };
  }
  const nextCursor = answer.nextCursor ? encodeFeedCursor(answer.nextCursor) : undefined;
  if (!answer.ids.length) {
    count('served');
    return { ok: true, page: { data: [], nextCursor, feedMs: answer.ms, route: answer.route } };
  }
  let rows: T[];
  const endHydrate = hydrateDuration.startTimer();
  try {
    rows = await deps.hydrate(answer.ids);
  } catch {
    count('error', 'hydrate:error');
    return { ok: false, reason: 'hydrate:error' };
  } finally {
    endHydrate();
  }
  // Every id was filtered out by the hydrate's own checks (its statement timeout is thrown, see
  // feedHydrateQuery). That is not the end of the feed, so the feed's cursor travels with it.
  if (!rows.length) {
    count('error', 'hydrate:empty');
    return { ok: false, reason: 'hydrate:empty', nextCursor };
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const data = answer.ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
  count('served');
  return { ok: true, page: { data, nextCursor, feedMs: answer.ms, route: answer.route } };
}

export function feedPrimaryAvailable() {
  return !!env.FEED_SERVICE_URL;
}

export function fetchFeedPrimary(query: string, timeoutMs: number) {
  return fetchFeedAnswer(env.FEED_SERVICE_URL as string, query, timeoutMs, 'primary');
}
