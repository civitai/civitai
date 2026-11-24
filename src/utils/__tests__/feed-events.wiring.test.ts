import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { __trackBufferTestHooks } from '~/components/TrackView/trackEventBuffer';
import { setFeedEventsCache, setFeedEventsEnabled } from '~/utils/feed-events';

const { routerEvents } = vi.hoisted(() => {
  const handlers = new Set<() => void>();
  return {
    routerEvents: {
      on: (_: string, fn: () => void) => handlers.add(fn),
      off: (_: string, fn: () => void) => handlers.delete(fn),
      emit: () => handlers.forEach((fn) => fn()),
    },
  };
});
vi.mock('next/router', () => ({ default: { pathname: '/models', events: routerEvents } }));

const key = [['model', 'getAll'], { input: {}, type: 'infinite' }];
const page = { items: [], nextCursor: null };

vi.stubGlobal('window', new EventTarget());

describe('feed events wiring', () => {
  it('starts when both the flag and the cache are set, counts route visits, and stops with the flag', () => {
    const client = new QueryClient();
    const setPages = (n: number) =>
      client.setQueryData(key, { pages: Array(n).fill(page), pageParams: [] });
    const pending = __trackBufferTestHooks.pendingCount;
    __trackBufferTestHooks.reset();

    setFeedEventsEnabled(true);
    setPages(1);
    expect(pending()).toBe(0);

    setFeedEventsCache(client.getQueryCache());
    expect(pending()).toBe(1);

    routerEvents.emit();
    new QueryObserver(client, { queryKey: key, enabled: false }).subscribe(() => undefined);
    expect(pending()).toBe(2);

    setFeedEventsEnabled(false);
    setPages(2);
    expect(pending()).toBe(2);
    __trackBufferTestHooks.reset();
  });
});
