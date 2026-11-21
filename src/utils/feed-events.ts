import Router from 'next/router';
import type { Query, QueryCache, QueryCacheNotifyEvent } from '@tanstack/react-query';
import { enqueueTrackEvent } from '~/components/TrackView/trackEventBuffer';
import { getImpressionSessionKey } from '~/components/TrackView/impressionBuffer';
import type { TrackFeedInput } from '~/server/schema/track.schema';
import { FEED_EVENT_FILTER_KEYS } from '~/shared/constants/feed-events.constants';
import type { FeedEventFeed } from '~/shared/constants/feed-events.constants';

// tRPC v11 keys an infinite query as [path segments, { input, type: 'infinite' }].
const FEED_PROCEDURES: Record<string, FeedEventFeed> = {
  'model.getAll': 'models',
  'image.getInfinite': 'images',
  'post.getInfinite': 'posts',
  'article.getInfinite': 'articles',
};

// The search pages' URL names for facets the feed allowlist names differently.
const SEARCH_PARAM_FILTERS: Record<string, string> = {
  baseModel: 'baseModels',
  modelType: 'types',
};

type Deps = {
  cache: QueryCache;
  getPage: () => string;
  getSessionKey: () => string;
  send: (data: TrackFeedInput) => void;
};

type InfiniteData = { pages?: unknown[] };

function feedQuery(query: Query) {
  const [path, meta] = query.queryKey as [unknown, unknown];
  if (!Array.isArray(path) || (meta as { type?: unknown } | undefined)?.type !== 'infinite')
    return undefined;
  const feed = FEED_PROCEDURES[path.join('.')];
  if (!feed) return undefined;
  const input = ((meta as { input?: unknown }).input ?? {}) as Record<string, unknown>;
  return { feed, input };
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
  let visit = 0;
  let started = false;

  function emit(query: Query, pagesFrom: number, pagesTo: number) {
    const feed = feedQuery(query);
    if (!feed) return;
    const page = getPage();
    const sort = typeof feed.input.sort === 'string' ? feed.input.sort : '';
    const filters = feedFilters(feed.feed, feed.input);
    for (let pageIndex = pagesFrom; pageIndex < pagesTo; pageIndex++)
      send({
        event: 'load',
        sessionKey: getSessionKey(),
        feed: feed.feed,
        page,
        sort,
        pageIndex,
        filters,
      });
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
      started = true;
      const unsubscribe = cache.subscribe(onEvent);
      return () => {
        started = false;
        unsubscribe();
      };
    },
    newVisit() {
      visit++;
    },
    /** Facet-only search browsing (no query text) as a search feed load. */
    searchLoad(index: string, { sortBy, ...facets }: Record<string, unknown>) {
      if (!started) return;
      const named = Object.fromEntries(
        Object.entries(facets).map(([key, value]) => [SEARCH_PARAM_FILTERS[key] ?? key, value])
      );
      send({
        event: 'load',
        sessionKey: getSessionKey(),
        feed: 'search',
        page: getPage(),
        // sortBy is an index name, `<index>:<field>:<direction>`.
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
      });
    },
  };
}

let tracker: ReturnType<typeof createFeedEventsTracker> | undefined;
let stop: (() => void) | undefined;
let cache: QueryCache | undefined;
let wanted = false;

const onRouteChange = () => tracker?.newVisit();

function apply() {
  if (wanted && cache && !stop) {
    tracker ??= createFeedEventsTracker({
      cache,
      getPage: () => Router.pathname,
      getSessionKey: getImpressionSessionKey,
      send: (data) => enqueueTrackEvent({ kind: 'feed', data }),
    });
    stop = tracker.start();
    Router.events.on('routeChangeComplete', onRouteChange);
  } else if (!wanted && stop) {
    stop();
    stop = undefined;
    Router.events.off('routeChangeComplete', onRouteChange);
  }
}

/** Starts or stops feed load events with the feedImpressions flag. Browser only. */
export function setFeedEventsEnabled(enabled: boolean) {
  wanted = enabled;
  apply();
}

/** The browser query cache to watch, handed over where the client is created. */
export function setFeedEventsCache(queryCache: QueryCache) {
  cache = queryCache;
  apply();
}

export const sendSearchFeedLoad = (index: string, params: Record<string, unknown>) =>
  tracker?.searchLoad(index, params);
