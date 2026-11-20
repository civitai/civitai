import { describe, expect, it } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { createFeedEventsTracker } from '~/utils/feed-events';
import type { TrackFeedInput } from '~/server/schema/track.schema';

const input = {
  sort: 'Highest Rated',
  hidePaid: true,
  baseModels: ['SDXL 1.0', 'Pony'],
  username: 'someone',
  browsingLevel: 1,
};
const key = [['model', 'getAll'], { input, type: 'infinite' }];
const page = (...ids: number[]) => ({ items: ids.map((id) => ({ id })), nextCursor: null });

function setup() {
  const client = new QueryClient();
  const sent: TrackFeedInput[] = [];
  const tracker = createFeedEventsTracker({
    cache: client.getQueryCache(),
    getPage: () => '/models',
    getSessionKey: () => 's1',
    send: (data) => sent.push(data),
  });
  const setPages = (...pages: ReturnType<typeof page>[]) =>
    client.setQueryData(key, { pages, pageParams: pages.map((_, i) => i) });
  const watch = () =>
    new QueryObserver(client, { queryKey: key, enabled: false }).subscribe(() => undefined);
  return { client, sent, tracker, setPages, watch };
}

describe('feed load events', () => {
  it('sends one load per fetched page, with the allowlisted filters only', () => {
    const { sent, tracker, setPages } = setup();
    tracker.start();
    setPages(page(1, 2));
    setPages(page(1, 2), page(3));

    expect(sent.map((e) => e.pageIndex)).toEqual([0, 1]);
    expect(sent[0]).toEqual({
      event: 'load',
      sessionKey: 's1',
      feed: 'models',
      page: '/models',
      sort: 'Highest Rated',
      pageIndex: 0,
      filters: { hidePaid: 'true', baseModels: 'SDXL 1.0,Pony', browsingLevel: '1' },
    });
  });

  it('sends nothing for a refetch of pages already sent', () => {
    const { sent, tracker, setPages } = setup();
    tracker.start();
    setPages(page(1, 2), page(3));
    setPages(page(1, 2), page(3));
    expect(sent).toHaveLength(2);
  });

  it('a cached feed shown on a later visit is one page-0 load, however many hooks watch it', () => {
    const { sent, tracker, setPages, watch } = setup();
    tracker.start();
    setPages(page(1, 2), page(3));
    tracker.newVisit();
    watch();
    watch();
    expect(sent.map((e) => e.pageIndex)).toEqual([0, 1, 0]);
  });

  it('sends the pages the server filled before it started', () => {
    const { sent, tracker, setPages } = setup();
    setPages(page(1, 2));
    tracker.start();
    expect(sent.map((e) => e.pageIndex)).toEqual([0]);
  });

  it('ignores queries that are not feeds, and starts over after a feed query is removed', () => {
    const { client, sent, tracker, setPages } = setup();
    tracker.start();
    client.setQueryData([['model', 'getById'], { input: { id: 1 }, type: 'query' }], { id: 1 });
    setPages(page(1));
    client.removeQueries({ queryKey: key });
    setPages(page(1));
    expect(sent.map((e) => e.pageIndex)).toEqual([0, 0]);
  });

  it('remembers where each item was shown', () => {
    const { tracker, setPages } = setup();
    tracker.start();
    setPages(page(1, 2), page(3));
    expect(tracker.getContext('Model', 3)).toMatchObject({
      feed: 'models',
      pageIndex: 1,
      position: 2,
    });
  });
});
