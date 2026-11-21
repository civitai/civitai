import Router from 'next/router';
import type { Query, QueryCache, QueryCacheNotifyEvent } from '@tanstack/react-query';
import { enqueueTrackEvent } from '~/components/TrackView/trackEventBuffer';
import { getImpressionSessionKey } from '~/components/TrackView/impressionBuffer';
import type { ImpressionEntityType, TrackFeedInput } from '~/server/schema/track.schema';
import { FEED_EVENT_FILTER_KEYS } from '~/shared/constants/feed-events.constants';
import type { FeedEventFeed } from '~/shared/constants/feed-events.constants';

// tRPC v11 keys an infinite query as [path segments, { input, type: 'infinite' }].
const FEED_PROCEDURES: Record<string, { feed: FeedEventFeed; entityType: ImpressionEntityType }> = {
  'model.getAll': { feed: 'models', entityType: 'Model' },
  'image.getInfinite': { feed: 'images', entityType: 'Image' },
  'post.getInfinite': { feed: 'posts', entityType: 'Post' },
  'article.getInfinite': { feed: 'articles', entityType: 'Article' },
};

/** Where an entity was shown, for the seen and click events of phase 1b. */
export type FeedContext = {
  feed: FeedEventFeed;
  page: string;
  sort: string;
  pageIndex: number;
  position: number;
  filters: Record<string, string>;
};

// Past the cap the map is cleared rather than grown; a long session can lose the context of items
// it loaded long ago.
const CONTEXT_CAP = 5_000;

type Deps = {
  cache: QueryCache;
  getPage: () => string;
  getSessionKey: () => string;
  send: (data: TrackFeedInput) => void;
};

type InfiniteData = { pages?: ({ items?: { id?: unknown }[] } | null | undefined)[] };

function feedQuery(query: Query) {
  const [path, meta] = query.queryKey as [unknown, unknown];
  if (!Array.isArray(path) || (meta as { type?: unknown } | undefined)?.type !== 'infinite')
    return undefined;
  const procedure = FEED_PROCEDURES[path.join('.')];
  if (!procedure) return undefined;
  const input = ((meta as { input?: unknown }).input ?? {}) as Record<string, unknown>;
  return { ...procedure, input };
}

export function feedFilters(feed: FeedEventFeed, input: Record<string, unknown>) {
  const filters: Record<string, string> = {};
  for (const key of FEED_EVENT_FILTER_KEYS[feed]) {
    const value = input[key];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) filters[key] = value.join(',');
    } else if (typeof value !== 'object') filters[key] = String(value);
  }
  return filters;
}

export function createFeedEventsTracker({ cache, getPage, getSessionKey, send }: Deps) {
  // Per query: the route visit it was last emitted on, and how many of its pages have been.
  const emitted = new Map<string, { visit: number; pages: number }>();
  const context = new Map<string, FeedContext>();
  let visit = 0;

  function emit(query: Query, pagesFrom: number, pagesTo: number) {
    const feed = feedQuery(query);
    const pages = (query.state.data as InfiniteData | undefined)?.pages;
    if (!feed || !pages) return;
    const page = getPage();
    const sort = typeof feed.input.sort === 'string' ? feed.input.sort : '';
    const filters = feedFilters(feed.feed, feed.input);
    let position = 0;
    for (let pageIndex = 0; pageIndex < pagesTo; pageIndex++) {
      const items = pages[pageIndex]?.items ?? [];
      if (pageIndex >= pagesFrom) {
        send({
          event: 'load',
          sessionKey: getSessionKey(),
          feed: feed.feed,
          page,
          sort,
          pageIndex,
          filters,
        });
        if (context.size > CONTEXT_CAP) context.clear();
        items.forEach((item, i) => {
          if (typeof item?.id !== 'number') return;
          context.set(`${feed.entityType}:${item.id}`, {
            feed: feed.feed,
            page,
            sort,
            pageIndex,
            position: position + i,
            filters,
          });
        });
      }
      position += items.length;
    }
  }

  function onData(query: Query) {
    const pages = (query.state.data as InfiniteData | undefined)?.pages?.length ?? 0;
    if (!pages || !feedQuery(query)) return;
    const state = emitted.get(query.queryHash);
    if (!state) {
      emitted.set(query.queryHash, { visit, pages });
      emit(query, 0, pages);
    } else if (pages > state.pages) {
      emit(query, state.pages, pages);
      state.pages = pages;
    } else {
      // A refetch can come back shorter; the pages fetched after it are new loads.
      state.pages = pages;
    }
  }

  // A cached feed shown again on a later route visit counts as one page-0 load, however many hooks
  // watch it.
  function onRevisit(query: Query) {
    const state = emitted.get(query.queryHash);
    if (!state || state.visit === visit) return onData(query);
    const pages = (query.state.data as InfiniteData | undefined)?.pages?.length ?? 0;
    if (!pages) return;
    state.visit = visit;
    state.pages = Math.max(state.pages, pages);
    emit(query, 0, 1);
  }

  function onEvent(event: QueryCacheNotifyEvent) {
    if (event.type === 'removed') emitted.delete(event.query.queryHash);
    else if (event.type === 'observerAdded') onRevisit(event.query);
    else if (event.type === 'updated' && event.action.type === 'success') onData(event.query);
  }

  return {
    start() {
      for (const query of cache.getAll()) onData(query);
      return cache.subscribe(onEvent);
    },
    newVisit() {
      visit++;
    },
    getContext: (entityType: ImpressionEntityType, entityId: number) =>
      context.get(`${entityType}:${entityId}`),
  };
}

let tracker: ReturnType<typeof createFeedEventsTracker> | undefined;
let stop: (() => void) | undefined;

const onRouteChange = () => tracker?.newVisit();

/** Starts or stops feed load events with the feedImpressions flag. Browser only. */
export function setFeedEventsEnabled(enabled: boolean, cache: QueryCache) {
  if (enabled === !!stop) return;
  if (!enabled) {
    stop?.();
    stop = undefined;
    Router.events.off('routeChangeComplete', onRouteChange);
    return;
  }
  tracker ??= createFeedEventsTracker({
    cache,
    getPage: () => Router.pathname,
    getSessionKey: getImpressionSessionKey,
    send: (data) => enqueueTrackEvent({ kind: 'feed', data }),
  });
  stop = tracker.start();
  Router.events.on('routeChangeComplete', onRouteChange);
}

// The search pages' URL names for facets the feed allowlist names differently.
const SEARCH_PARAM_FILTERS: Record<string, string> = {
  baseModel: 'baseModels',
  modelType: 'types',
};

/** Facet-only search browsing (no query text) as a search feed load. */
export function sendSearchFeedLoad(index: string, params: Record<string, unknown>) {
  if (!stop) return;
  const { sortBy, ...facets } = params;
  const named = Object.fromEntries(
    Object.entries(facets).map(([key, value]) => [SEARCH_PARAM_FILTERS[key] ?? key, value])
  );
  enqueueTrackEvent({
    kind: 'feed',
    data: {
      event: 'load',
      sessionKey: getImpressionSessionKey(),
      feed: 'search',
      page: Router.pathname,
      sort:
        typeof sortBy === 'string'
          ? sortBy
              .split(':')
              .slice(1)
              .join(' ')
              .replace(/[^\w ]/g, ' ')
              .trim()
          : '',
      pageIndex: 0,
      filters: feedFilters('search', { ...named, index }),
    },
  });
}

export const getFeedContext = (entityType: ImpressionEntityType, entityId: number) =>
  tracker?.getContext(entityType, entityId);
