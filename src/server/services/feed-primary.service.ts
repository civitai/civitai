import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { registerCounterWithLabels, registerHistogram } from '~/server/prom/client';
import {
  admitFeedCall,
  feedDegradeEnabled,
  lastGoodKey,
  readLastGood,
  recordFeedCall,
  writeLastGood,
} from '~/server/services/feed-primary-degrade';
import type { CapturableSearchInput } from '~/server/services/feed-request-capture.service';
import {
  CURSOR_UNPARSED,
  DEEP_OFFSET,
  encodeFeedCursor,
  fetchFeedAnswer,
  mapSearchInputToFeedQuery,
  type FeedAnswer,
} from '~/server/services/feed-shadow.service';

// The feed-service call's budget. A 2.5s budget was tried (2026-11) and turned slow but healthy
// pages into 503s: timeouts rose about threefold while the feed service's own query time stayed
// flat, so the extra time is spent on the caller's side of the call, not in the feed's query.
// feed_primary_fetch_duration_seconds measures that caller-side time.
// The trade-off: image.getInfinite holds a shared heavy-image bulkhead slot (default 20 per pod)
// for the whole call, so with the breaker dark (feed-service-degrade off) a hung feed holds each
// slot for 5s, halving heavy-route throughput in an outage compared with 2.5s. The breaker is the
// intended cover for that.
export const FEED_PRIMARY_TIMEOUT_MS = 5_000;
const HUB_ROUTES = new Set(['union-walk', 'union-gather', 'empty']);

const requestCounter = registerCounterWithLabels({
  name: 'feed_primary_requests_total',
  help: 'Image-feed page requests on the feed service, by outcome',
  labelNames: ['outcome', 'reason', 'route'] as const,
});

// Named when this answer replaced a Meilisearch fallback behind a flag; the name is kept so the
// dashboards reading it keep their history.
const unservedAnswerCounter = registerCounterWithLabels({
  name: 'feed_primary_meili_off_total',
  help: 'Image-feed requests the feed service did not serve, by the answer they got instead',
  labelNames: ['answer', 'reason', 'route'] as const,
});
/** `answer`: empty (an empty page), unavailable (a retryable 503) or refused (a 400). */
export const countUnservedAnswer = (
  answer: 'empty' | 'unavailable' | 'refused',
  reason: string,
  route: FeedPrimaryRoute
) => unservedAnswerCounter.inc({ answer, reason: reasonLabel(reason), route });

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
// A 400 is a request the mapper thought the feed could take and the feed refused: a limit the
// two disagree on. One a minute with the feed's own reason is enough to find which.
let refusedLoggedAt = 0;
function logRefused(query: string, error: string | undefined, route: FeedPrimaryRoute | undefined) {
  const now = Date.now();
  if (now - refusedLoggedAt < UNMAPPED_LOG_INTERVAL_MS) return;
  refusedLoggedAt = now;
  logToAxiom(
    { type: 'warning', name: 'feed-primary-refused', route, error, query: query.slice(0, 2000) },
    'civitai-prod'
  );
}
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

// The caller's wall-clock time for the feed call, from just before the request to the parsed answer
// (or the error). The feed's answer carries no server time of its own, so this is the whole call as
// this process sees it; compare it with the feed service's own query-time metric to find the
// caller-side share. `outcome` is ok (any answer below 500), timeout or error (thrown or 5xx).
const fetchDuration = registerHistogram({
  name: 'feed_primary_fetch_duration_seconds',
  help: 'Caller wall-clock time of the image feed call to the feed service, by route and outcome',
  labelNames: ['route', 'outcome'] as const,
  // Past the 5s budget too, so a timeout whose timer fired late (event-loop lag) is still seen.
  buckets: [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 10],
});

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
  /** The feed failed and this is the pod's last good copy of the page (feed-primary-degrade). */
  stale?: true;
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

export type DatapacketRescue = 'rescued' | 'still-empty';

/**
 * Loads the feed's ids. A DataPacket read that finds none of them is retried once on the read
 * replica: DataPacket answers no rows for images the primary has (on 22 Oct 08:30 UTC, 21 of the
 * 23 ids in a burst of empty gallery pages were on the read replica, published and scanned), and
 * the search index fallback would hydrate from DataPacket again. Only an empty page pays for it.
 */
export async function hydrateWithReadRescue<T, Q extends { dbTarget?: string }>(
  query: Q,
  load: (query: Q) => Promise<T[]>,
  onRescue?: (outcome: DatapacketRescue) => void
): Promise<T[]> {
  const rows = await load(query);
  if (rows.length || query.dbTarget !== 'datapacket') return rows;
  const rescued = await load({ ...query, dbTarget: 'read' });
  onRescue?.(rescued.length ? 'rescued' : 'still-empty');
  return rescued;
}

/** The image query for hydrating exactly `ids`: the request's filters without its paging,
 *  period or jump, all applied by the feed (getAllImages would cut the period on createdAt). */
export function feedHydrateQuery<
  T extends {
    cursor?: unknown;
    skip?: number;
    offset?: number;
    entry?: number;
    limit?: number;
    period?: unknown;
    jumpTo?: string;
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
  | 'jumpTo'
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
    // The feed bounds the month on sortAt; the hydrate's createdAt bound would drop an image
    // created before the month and published inside it.
    jumpTo: _jumpTo,
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
  const mapping = mapSearchInputToFeedQuery(input, 'primary', deps.route);
  // An inclusion list of only impossible ids (prod sends `tags: [0]`) matches nothing on the
  // search index either.
  if (!mapping.ok && (mapping.reason === 'tags:none' || mapping.reason === 'ids:none')) {
    count('served');
    return { ok: true, page: { data: [], nextCursor: undefined, feedMs: 0 } };
  }
  if (!mapping.ok) {
    const rejected = mapping.reason === DEEP_OFFSET || mapping.reason === CURSOR_UNPARSED;
    count(rejected ? 'rejected' : 'unmapped', mapping.reason);
    if (mapping.reason !== DEEP_OFFSET) logUnmapped(reasonLabel(mapping.reason), input);
    return { ok: false, reason: mapping.reason };
  }
  // Behind feed-service-degrade: a circuit breaker on the call, and an anonymous first page the
  // feed fails to answer is served from the last good copy (see feed-primary-degrade).
  const degrade = feedDegradeEnabled();
  const lastGoodRoute = deps.route ?? 'website';
  const cacheKey = degrade ? lastGoodKey(input, mapping.query) : undefined;
  let stale = false;
  let answer: FeedAnswer;
  const admission = degrade ? admitFeedCall() : undefined;
  // feed_primary_requests_total counts what the feed did (served, timeout, error, breaker, ...);
  // a stale page served in its place is counted in feed_primary_last_good_total instead.
  if (admission && !admission.admitted) {
    count('breaker');
    const cached = readLastGood(lastGoodRoute, cacheKey, 'breaker');
    if (!cached) return { ok: false, reason: 'breaker' };
    answer = cached;
    stale = true;
  } else {
    let failure: string | undefined;
    // Date.now rather than an hrtime timer, so a test with a faked clock can pin the value.
    const fetchStarted = Date.now();
    try {
      answer = await deps.fetchFeed(mapping.query, deps.timeoutMs ?? FEED_PRIMARY_TIMEOUT_MS);
      if (answer.status >= 500) failure = `status:${answer.status}`;
    } catch (e) {
      const name = (e as Error)?.name;
      const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error';
      failure = reason;
      answer = { status: 0, ms: 0, ids: [] };
    }
    const fetchOutcome = !failure ? 'ok' : failure === 'timeout' ? 'timeout' : 'error';
    fetchDuration.observe(
      { route: lastGoodRoute, outcome: fetchOutcome },
      (Date.now() - fetchStarted) / 1000
    );
    if (admission) recordFeedCall(admission, failure !== undefined);
    // Counted whether or not a stale page then answers, so the timeout and error rates stay the
    // feed's own.
    if (failure === 'timeout') count('timeout');
    else if (failure === 'error') count('error', 'fetch');
    else if (failure) count('error', failure);
    const cached =
      failure && degrade ? readLastGood(lastGoodRoute, cacheKey, reasonLabel(failure)) : undefined;
    if (cached) {
      answer = cached;
      stale = true;
    } else if (failure) {
      return { ok: false, reason: failure };
    } else if (cacheKey && answer.status === 200) {
      writeLastGood(lastGoodRoute, cacheKey, answer);
    }
  }
  if (answer.status !== 200) {
    if (answer.status < 500) count('error', `status:${answer.status}`);
    if (answer.status === 400) logRefused(mapping.query, answer.error, deps.route);
    return { ok: false, reason: `status:${answer.status}` };
  }
  // A feed build without the any-of sources ignores them and answers with the open feed. Only
  // a plan that took the union, or the feed's own empty page, is the hub.
  if (input.hubId && !HUB_ROUTES.has(answer.route ?? '')) {
    count('error', 'hub:route');
    return { ok: false, reason: 'hub:route' };
  }
  const nextCursor = answer.nextCursor ? encodeFeedCursor(answer.nextCursor) : undefined;
  const served = (data: T[]): FeedPrimaryResult<T> => {
    if (!stale) count('served');
    const page: FeedPrimaryPage<T> = { data, nextCursor, feedMs: answer.ms, route: answer.route };
    return { ok: true, page: stale ? { ...page, stale: true } : page };
  };
  if (!answer.ids.length) return served([]);
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
  return served(data);
}

export function feedPrimaryAvailable() {
  return !!env.FEED_SERVICE_URL;
}

export function fetchFeedPrimary(query: string, timeoutMs: number) {
  return fetchFeedAnswer(env.FEED_SERVICE_URL as string, query, timeoutMs, 'primary');
}
