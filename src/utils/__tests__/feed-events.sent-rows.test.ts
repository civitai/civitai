import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  __impressionBufferTestHooks,
  flushImpressions,
  recordFeedSeen,
} from '~/components/TrackView/impressionBuffer';
import type { FeedEventContext } from '~/components/TrackView/impressionBuffer';
import { __trackImpressionTestHooks as dwellHooks } from '~/components/TrackView/useTrackImpression';
import { setFeedEventsCache, setFeedEventsEnabled, trackSearchPage } from '~/utils/feed-events';
import { __trackBufferTestHooks } from '~/components/TrackView/trackEventBuffer';
import type { TrackBatchEvent } from '~/server/schema/track.schema';

vi.mock('next/router', () => ({
  default: { pathname: '/search/models', events: { on: () => undefined, off: () => undefined } },
}));
vi.stubGlobal(
  'window',
  Object.assign(new EventTarget(), { location: { pathname: '/search/models' } })
);
// The network is the boundary: rows are read off the bodies the shared buffer POSTs.
const fetchMock = vi.fn<(url: string, init: { body: string }) => Promise<{ ok: boolean }>>(() =>
  Promise.resolve({ ok: true })
);
vi.stubGlobal('fetch', fetchMock);

const feedRows = () => {
  __trackBufferTestHooks.flush();
  return fetchMock.mock.calls
    .flatMap(([, init]) => JSON.parse(init.body) as TrackBatchEvent[])
    .flatMap((e) => (e.kind === 'feed' ? [e.data] : []));
};
const context = (pageIndex: number): FeedEventContext => ({
  feed: 'models',
  page: '/models',
  sort: 'Newest',
  pageIndex,
  filters: { hidePaid: 'true' },
});

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  fetchMock.mockClear();
  __trackBufferTestHooks.reset();
  __impressionBufferTestHooks.reset();
});

describe('feed seen rows', () => {
  it('one row per load with its context, each id once', () => {
    const first = context(0);
    const second = context(1);
    recordFeedSeen(first, 1);
    recordFeedSeen(first, 2);
    recordFeedSeen(first, 1);
    recordFeedSeen(second, 3);
    flushImpressions();
    recordFeedSeen(first, 2);
    flushImpressions();
    expect(feedRows()).toEqual([
      { event: 'seen', sessionKey: expect.any(String), ...first, seenIds: [1, 2] },
      { event: 'seen', sessionKey: expect.any(String), ...second, seenIds: [3] },
    ]);
  });

  it('flushes at 250 ids, so no row carries more than the server accepts', () => {
    const load = context(0);
    for (let id = 1; id <= 251; id++) recordFeedSeen(load, id);
    expect(feedRows().map((row) => row.seenIds?.length)).toEqual([250]);
    flushImpressions();
    expect(feedRows().map((row) => row.seenIds?.length)).toEqual([250, 1]);
  });
});

describe('the card hook', () => {
  it('a matured dwell adds the card to its feed load seen set', () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    setFeedEventsCache(client.getQueryCache());
    setFeedEventsEnabled(true);
    client.setQueryData([['image', 'getInfinite'], { input: {}, type: 'infinite' }], {
      pages: [{ items: [{ id: 8 }, { id: 9 }] }],
      pageParams: [0],
    });
    const element = {} as Element;
    const state = { targets: [{ entityType: 'Image' as const, entityId: 9 }], timer: null };
    const registry = {
      observer: { unobserve: () => undefined } as unknown as IntersectionObserver,
      elements: new Map([[element, state]]),
      intersecting: new Set([element]),
    };
    dwellHooks.armDwell(registry, element, state);
    vi.advanceTimersByTime(dwellHooks.DWELL_MS);
    flushImpressions();
    expect(feedRows().filter((row) => row.event === 'seen')).toEqual([
      expect.objectContaining({
        feed: 'images',
        page: '/search/models',
        pageIndex: 0,
        seenIds: [9],
      }),
    ]);
  });
});

describe('switching feed events off', () => {
  it('drops seen ids not yet sent, and counts them if seen again once back on', () => {
    const load = context(0);
    setFeedEventsCache(new QueryClient().getQueryCache());
    setFeedEventsEnabled(true);
    recordFeedSeen(load, 1);
    setFeedEventsEnabled(false);
    flushImpressions();
    expect(feedRows()).toEqual([]);

    setFeedEventsEnabled(true);
    recordFeedSeen(load, 1);
    flushImpressions();
    expect(feedRows().map((row) => row.seenIds)).toEqual([[1]]);
  });
});

describe('search page visits (the SearchLayout call site)', () => {
  beforeEach(() => {
    setFeedEventsCache(new QueryClient().getQueryCache());
    setFeedEventsEnabled(true);
  });

  it('a text search goes to trackSearch, and no feed row carries it', () => {
    const trackSearch = vi.fn();
    trackSearchPage(
      'models_v9',
      { query: 'cat', sortBy: 'models_v9:metrics.thumbsUpCount:desc', baseModel: 'SDXL 1.0' },
      trackSearch
    );
    expect(trackSearch).toHaveBeenCalledWith({
      query: 'cat',
      index: 'models_v9:metrics.thumbsUpCount:desc',
      filters: { baseModel: 'SDXL 1.0' },
    });
    expect(feedRows()).toEqual([]);
  });

  it('facet-only browsing is one search feed load, and not a search', () => {
    const trackSearch = vi.fn();
    trackSearchPage(
      'models_v9',
      { sortBy: 'models_v9:metrics.thumbsUpCount:desc', baseModel: 'SDXL 1.0' },
      trackSearch
    );
    expect(trackSearch).not.toHaveBeenCalled();
    expect(feedRows()).toEqual([
      expect.objectContaining({
        event: 'load',
        feed: 'search',
        page: '/search/models',
        sort: 'metrics thumbsUpCount desc',
        filters: { index: 'models_v9', baseModels: 'SDXL 1.0' },
      }),
    ]);
  });
});
