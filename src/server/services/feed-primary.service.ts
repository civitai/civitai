import { env } from '~/env/server';
import { registerCounterWithLabels } from '~/server/prom/client';
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
  const rows = await deps.hydrate(answer.ids);
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
