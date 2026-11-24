import { describe, expect, it } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { createFeedEventsTracker } from '~/utils/feed-events';
import type { TrackFeedInput } from '~/server/schema/track.schema';

const key = [
  ['model', 'getAll'],
  { input: { sort: 'Highest Rated', hidePaid: true }, type: 'infinite' },
];
const page = (...ids: number[]) => ({ items: ids.map((id) => ({ id })), nextCursor: null });
const model = (entityId: number) => [{ entityType: 'Model' as const, entityId }];

function setup() {
  const client = new QueryClient();
  const sent: TrackFeedInput[] = [];
  let route = '/models';
  const tracker = createFeedEventsTracker({
    cache: client.getQueryCache(),
    getPage: () => route,
    getSessionKey: () => 's1',
    send: (data) => sent.push(data),
  });
  const setPages = (...pages: ReturnType<typeof page>[]) =>
    client.setQueryData(key, { pages, pageParams: pages.map((_, i) => i) });
  const clicks = () => sent.filter((e) => e.event === 'click');
  return { client, sent, tracker, setPages, clicks, goTo: (r: string) => (route = r) };
}

describe('feed clicks and the item context map', () => {
  it('a click carries its page load context and its position across pages', () => {
    const { tracker, setPages, clicks } = setup();
    tracker.start();
    setPages(page(1, 2), page(3, 4));
    tracker.click(model(4));
    expect(clicks()).toEqual([
      {
        event: 'click',
        sessionKey: 's1',
        feed: 'models',
        page: '/models',
        sort: 'Highest Rated',
        pageIndex: 1,
        filters: { hidePaid: 'true' },
        entityType: 'Model',
        entityId: 4,
        position: 3,
      },
    ]);
  });

  it('uses the first target a feed loaded, so a model card is the model, not its cover', () => {
    const { tracker, setPages, clicks } = setup();
    tracker.start();
    setPages(page(7));
    tracker.click([{ entityType: 'Image', entityId: 7 }, ...model(7)]);
    expect(clicks().map((e) => [e.entityType, e.entityId])).toEqual([['Model', 7]]);
  });

  it('records nothing for an item no feed on this page loaded', () => {
    const { tracker, setPages, clicks, goTo } = setup();
    tracker.start();
    setPages(page(1));
    tracker.click(model(99));
    goTo('/user/[username]/shop');
    tracker.click(model(1));
    expect(clicks()).toHaveLength(0);
  });

  it('a refetch that changes a page maps its new items without a new load', () => {
    const { sent, tracker, setPages, clicks } = setup();
    tracker.start();
    setPages(page(1, 2));
    setPages(page(5, 1));
    tracker.click(model(5));
    expect(clicks().map((e) => [e.entityId, e.position, e.pageIndex])).toEqual([[5, 0, 0]]);
    expect(sent.filter((e) => e.event === 'load')).toHaveLength(1);
  });

  it('a cached feed revisited from another route counts under the new route', () => {
    const { client, tracker, setPages, clicks, goTo } = setup();
    tracker.start();
    setPages(page(1), page(2));
    goTo('/');
    tracker.newVisit();
    new QueryObserver(client, { queryKey: key, enabled: false }).subscribe(() => undefined);
    tracker.click(model(2));
    expect(clicks().map((e) => [e.page, e.pageIndex, e.position])).toEqual([['/', 1, 1]]);
  });

  it('forgets a removed query and everything after stop', () => {
    const { client, tracker, setPages, clicks } = setup();
    const stop = tracker.start();
    setPages(page(1));
    client.removeQueries({ queryKey: key });
    tracker.click(model(1));
    setPages(page(1));
    stop();
    tracker.click(model(1));
    expect(clicks()).toHaveLength(0);
  });
});
