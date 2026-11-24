import Router from 'next/router';
import type { Query, QueryCache, QueryCacheNotifyEvent } from '@tanstack/react-query';
import { enqueueTrackEvent } from '~/components/TrackView/trackEventBuffer';
import {
  clearPendingFeedSeen,
  getImpressionSessionKey,
  recordFeedSeen,
} from '~/components/TrackView/impressionBuffer';
import type { FeedEventContext } from '~/components/TrackView/impressionBuffer';
import type {
  ImpressionEntityType,
  TrackFeedInput,
  TrackSearchInput,
} from '~/server/schema/track.schema';
import {
  FEED_EVENT_FILTER_KEYS,
  FEED_EVENT_INDEX_MAX,
} from '~/shared/constants/feed-events.constants';
import type { FeedEventFeed } from '~/shared/constants/feed-events.constants';

// tRPC v11 keys an infinite query as [path segments, { input, type: 'infinite' }].
const FEED_PROCEDURES: Record<string, { feed: FeedEventFeed; entityType: ImpressionEntityType }> = {
  'model.getAll': { feed: 'models', entityType: 'Model' },
  'image.getInfinite': { feed: 'images', entityType: 'Image' },
  'post.getInfinite': { feed: 'posts', entityType: 'Post' },
  'article.getInfinite': { feed: 'articles', entityType: 'Article' },
};

const FEED_ITEMS_MAX = 5_000;

type FeedItem = { context: FeedEventContext; position: number; queryHash: string };
type FeedTarget = { entityType: ImpressionEntityType; entityId: number };

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

const pageItemIds = (page: unknown): unknown[] => {
  const items = (page as { items?: unknown } | null | undefined)?.items;
  return Array.isArray(items) ? items.map((item) => (item as { id?: unknown } | null)?.id) : [];
};

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
  // Per query: this visit's load of each page, which that page's seen and click rows carry.
  const loads = new Map<string, FeedEventContext[]>();
  // entityType:id -> the load it last came from. If one item is in two feeds, the latest load wins.
  const items = new Map<string, FeedItem>();
  let visit = 0;
  let started = false;

  // Points each item at its page's load. An item another query holds is taken only by a page loaded
  // now, in [from, to): a refetch must not move credit back and forth between two queries.
  function mapItems(query: Query, from = 0, to = 0) {
    const feed = feedQuery(query);
    const pages = (query.state.data as InfiniteData | undefined)?.pages;
    const contexts = loads.get(query.queryHash);
    if (!feed || !pages || !contexts) return;
    let position = 0;
    pages.forEach((page, pageIndex) => {
      const context = contexts[pageIndex];
      const loadedNow = pageIndex >= from && pageIndex < to;
      for (const id of pageItemIds(page)) {
        const key = `${feed.entityType}:${id}`;
        const held = items.get(key);
        if (
          context &&
          typeof id === 'number' &&
          (loadedNow || !held || held.queryHash === query.queryHash)
        ) {
          items.delete(key);
          items.set(key, { context, position, queryHash: query.queryHash });
          if (items.size > FEED_ITEMS_MAX) items.delete(items.keys().next().value as string);
        }
        position++;
      }
    });
  }

  function emit(query: Query, from: number, to: number) {
    const feed = feedQuery(query);
    if (!feed) return;
    const page = getPage();
    const sort = typeof feed.input.sort === 'string' ? feed.input.sort : '';
    const filters = feedFilters(feed.feed, feed.input);
    const contexts = loads.get(query.queryHash) ?? [];
    loads.set(query.queryHash, contexts);
    for (let pageIndex = from; pageIndex < to; pageIndex++) {
      const context: FeedEventContext = { feed: feed.feed, page, sort, pageIndex, filters };
      contexts[pageIndex] = context;
      send({ event: 'load', sessionKey: getSessionKey(), ...context });
    }
    mapItems(query, from, to);
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
      // A refetch can change what a page holds without being a new load.
      mapItems(query);
    }
  }

  // A cached feed shown again on a later route visit counts as one page-0 load, however many hooks
  // watch it. The other cached pages keep the loads they were sent under, so a row never names a
  // page load this visit did not send; under a different route pattern they then match nothing.
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
    if (event.type === 'removed') {
      emitted.delete(event.query.queryHash);
      loads.delete(event.query.queryHash);
      for (const [key, item] of items)
        if (item.queryHash === event.query.queryHash) items.delete(key);
    } else if (event.type === 'observerAdded') onRevisit(event.query);
    else if (event.type === 'updated' && event.action.type === 'success') onData(event.query);
  }

  // The feed item a card shows: the first of its targets a feed on this page loaded. An item loaded
  // under another page pattern (a feed left behind) is not this card's.
  function findItem(targets: FeedTarget[]) {
    const page = getPage();
    for (const target of targets) {
      const item = items.get(`${target.entityType}:${target.entityId}`);
      if (item && item.context.page === page) return { target, item };
    }
  }

  return {
    start() {
      for (const query of cache.getAll()) onData(query);
      started = true;
      const unsubscribe = cache.subscribe(onEvent);
      return () => {
        started = false;
        unsubscribe();
        items.clear();
      };
    },
    findItem,
    click(targets: FeedTarget[]) {
      const found = findItem(targets);
      if (!found) return;
      send({
        event: 'click',
        sessionKey: getSessionKey(),
        ...found.item.context,
        entityType: found.target.entityType,
        entityId: found.target.entityId,
        // Past the server's cap the row would be dropped; the cap reads as "this deep or deeper".
        position: Math.min(found.item.position, FEED_EVENT_INDEX_MAX),
      });
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
    clearPendingFeedSeen();
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

/** A search page visit: a text search goes to the search table, facet-only browsing is a feed load. */
export function trackSearchPage(
  indexName: string,
  {
    query,
    sortBy: index,
    ...filters
  }: { query?: string; sortBy?: string } & Record<string, unknown>,
  trackSearch: (input: TrackSearchInput) => void
) {
  if (query && index) trackSearch({ query, index, filters });
  else if (!query) sendSearchFeedLoad(indexName, { sortBy: index, ...filters });
}

/** A card was seen: adds it to its load's seen set, if a feed on this page loaded it. */
export function recordFeedItemSeen(targets: FeedTarget[]) {
  const found = tracker?.findItem(targets);
  if (found) recordFeedSeen(found.item.context, found.target.entityId);
}

/** A link in a card was clicked: one click row, if a feed on this page loaded the card. */
export const recordFeedItemClick = (targets: FeedTarget[]) => tracker?.click(targets);
