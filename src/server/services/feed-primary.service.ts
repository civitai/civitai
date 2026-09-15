import { env } from '~/env/server';
import { registerCounterWithLabels, registerHistogram } from '~/server/prom/client';
import type { CapturableSearchInput } from '~/server/services/feed-request-capture.service';
import {
  encodeFeedCursor,
  fetchFeedAnswer,
  mapSearchInputToFeedQuery,
  type FeedAnswer,
} from '~/server/services/feed-shadow.service';

export const FEED_PRIMARY_TIMEOUT_MS = 5_000;

const requestCounter = registerCounterWithLabels({
  name: 'feed_primary_requests_total',
  help: 'Image-feed searches answered by the feed service instead of Meilisearch, by outcome',
  labelNames: ['outcome'] as const,
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
};
export type FeedPrimaryResult<T> =
  | { ok: true; page: FeedPrimaryPage<T> }
  | { ok: false; reason: string };

export type FeedPrimaryDeps<T extends { id: number }> = {
  fetchFeed: (query: string, timeoutMs: number) => Promise<FeedAnswer>;
  /** Loads the page's records in any order; the feed's order is restored here. */
  hydrate: (ids: number[]) => Promise<T[]>;
  timeoutMs?: number;
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
  }
>(
  input: T,
  ids: number[]
): Omit<T, 'cursor' | 'skip' | 'offset' | 'entry' | 'period'> & {
  ids: number[];
  limit: number;
  period: 'AllTime';
} {
  const {
    cursor: _cursor,
    skip: _skip,
    offset: _offset,
    entry: _entry,
    period: _period,
    ...rest
  } = input;
  return { ...rest, ids, limit: ids.length, period: 'AllTime' };
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
  const mapping = mapSearchInputToFeedQuery(input, 'primary');
  if (!mapping.ok) {
    requestCounter.inc({ outcome: 'unmapped' });
    return { ok: false, reason: mapping.reason };
  }
  let answer: FeedAnswer;
  try {
    answer = await deps.fetchFeed(mapping.query, deps.timeoutMs ?? FEED_PRIMARY_TIMEOUT_MS);
  } catch (e) {
    const name = (e as Error)?.name;
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error';
    requestCounter.inc({ outcome: reason });
    return { ok: false, reason };
  }
  if (answer.status !== 200) {
    requestCounter.inc({ outcome: 'error' });
    return { ok: false, reason: `status:${answer.status}` };
  }
  const nextCursor = answer.nextCursor ? encodeFeedCursor(answer.nextCursor) : undefined;
  if (!answer.ids.length) {
    requestCounter.inc({ outcome: 'served' });
    return { ok: true, page: { data: [], nextCursor, feedMs: answer.ms, route: answer.route } };
  }
  let rows: T[];
  const endHydrate = hydrateDuration.startTimer();
  try {
    rows = await deps.hydrate(answer.ids);
  } catch {
    requestCounter.inc({ outcome: 'error' });
    return { ok: false, reason: 'hydrate:error' };
  } finally {
    endHydrate();
  }
  // getAllImages answers its own statement timeout with an empty page; ids that hydrate to
  // nothing are that, not the end of the feed.
  if (!rows.length) {
    requestCounter.inc({ outcome: 'error' });
    return { ok: false, reason: 'hydrate:empty' };
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const data = answer.ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
  requestCounter.inc({ outcome: 'served' });
  return { ok: true, page: { data, nextCursor, feedMs: answer.ms, route: answer.route } };
}

export function feedPrimaryAvailable() {
  return !!env.FEED_SERVICE_URL;
}

export function fetchFeedPrimary(query: string, timeoutMs: number) {
  return fetchFeedAnswer(env.FEED_SERVICE_URL as string, query, timeoutMs, 'primary');
}
