// @vitest-environment happy-dom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

/**
 * The live points components and hook, run for real against a recording signals layer and query
 * cache: which topic each subscribes to, and which cache entry a push writes. The pure readers are
 * tested on their own; this pins how the screens use them.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { signals, cache } = vi.hoisted(() => ({
  signals: {
    topics: [] as (string | undefined)[],
    handlers: {} as Record<string, (payload: unknown) => void>,
  },
  cache: {
    wornHat: { setData: vi.fn() },
    myHats: { setData: vi.fn() },
    standings: { setData: vi.fn() },
  },
}));
vi.mock('~/components/Signals/SignalsProvider', () => ({
  useSignalTopic: (topic: string | undefined) => void signals.topics.push(topic),
  useSignalConnection: (message: string, cb: (payload: unknown) => void) =>
    void (signals.handlers[message] = cb),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy(
    {},
    {
      useUtils: () => ({
        event: {
          getWornHat: cache.wornHat,
          getMyHats: cache.myHats,
          getStandings: cache.standings,
        },
      }),
    }
  ),
}));

const { WornHatLivePoints, MyHatsLivePoints, useEventTeamsLivePoints } = await import(
  '~/components/Events/ScoredEvent/event-points-live'
);

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => {
  signals.topics = [];
  signals.handlers = {};
  Object.values(cache).forEach((c) => c.setData.mockReset());
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});
function render(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(element));
}
// Runs a setData updater the way React Query would, against `previous`.
const applied = (setData: ReturnType<typeof vi.fn>, previous: unknown) => {
  const [, updater] = setData.mock.calls.at(-1)!;
  return (updater as (old: unknown) => unknown)(previous);
};

describe('WornHatLivePoints', () => {
  const props = {
    event: 'birthday2026',
    entityType: 'Image' as const,
    entityId: 5,
    topicId: 'abc',
  };
  const hat = { cosmeticId: 31, topicId: 'abc', points: 10, reactions: 1, name: 'Party Cap' };

  it("subscribes to its hat's topic and writes a push to the popover's own query", () => {
    render(React.createElement(WornHatLivePoints, props));
    expect(signals.topics).toContain('event-points:birthday2026:hat:abc');
    act(() =>
      signals.handlers['event-points:hat']({
        event: 'birthday2026',
        topicId: 'abc',
        points: 64,
        counts: { reactions: 3 },
      })
    );
    // The key must equal the popover's query input, { event, ...wornOn }.
    expect(cache.wornHat.setData.mock.calls.at(-1)![0]).toEqual({
      event: 'birthday2026',
      entityType: 'Image',
      entityId: 5,
    });
    expect(applied(cache.wornHat.setData, hat)).toEqual({ ...hat, points: 64, reactions: 3 });
    // Nothing loaded yet: a push must not invent a partial hat.
    expect(applied(cache.wornHat.setData, undefined)).toBeUndefined();
  });

  it("ignores another hat's push and another event's", () => {
    render(React.createElement(WornHatLivePoints, props));
    act(() =>
      signals.handlers['event-points:hat']({ event: 'birthday2026', topicId: 'zzz', points: 64 })
    );
    act(() => signals.handlers['event-points:hat']({ event: 'other', topicId: 'abc', points: 64 }));
    expect(cache.wornHat.setData).not.toHaveBeenCalled();
  });
});

describe('MyHatsLivePoints', () => {
  it('subscribes to every hat and writes a push to the getMyHats query', () => {
    render(
      React.createElement(MyHatsLivePoints, {
        event: 'birthday2026',
        topicIds: ['a', 'b'],
        inView: true,
      })
    );
    expect(signals.topics).toEqual(
      expect.arrayContaining(['event-points:birthday2026:hat:a', 'event-points:birthday2026:hat:b'])
    );
    act(() =>
      signals.handlers['event-points:hat']({
        event: 'birthday2026',
        topicId: 'b',
        points: 7,
        counts: { impressions: 4 },
      })
    );
    expect(cache.myHats.setData.mock.calls.at(-1)![0]).toEqual({ event: 'birthday2026' });
    expect(
      applied(cache.myHats.setData, [
        { topicId: 'a', points: 1, impressions: 0 },
        { topicId: 'b', points: 2, impressions: 0 },
      ])
    ).toEqual([
      { topicId: 'a', points: 1, impressions: 0 },
      { topicId: 'b', points: 7, impressions: 4 },
    ]);
    expect(applied(cache.myHats.setData, undefined)).toBeUndefined();
  });
});

describe('useEventTeamsLivePoints', () => {
  function Teams({ enabled }: { enabled: boolean }) {
    useEventTeamsLivePoints('birthday2026', 'teams', enabled);
    return null;
  }
  const push = { event: 'birthday2026', teams: { Blue: 900, Pink: 950 } };
  const standings = {
    teams: [
      { team: 'Blue', score: 800, rank: 1 },
      { team: 'Pink', score: 700, rank: 2 },
    ],
  };

  it('while the event runs: subscribes, and writes a push to the getStandings query', () => {
    render(React.createElement(Teams, { enabled: true }));
    expect(signals.topics.at(-1)).toBe('event-points:birthday2026:teams');
    act(() => signals.handlers['event-points:teams'](push));
    expect(cache.standings.setData.mock.calls.at(-1)![0]).toEqual({ event: 'birthday2026' });
    expect(applied(cache.standings.setData, standings)).toEqual({
      teams: [
        { team: 'Pink', score: 950, rank: 1 },
        { team: 'Blue', score: 900, rank: 2 },
      ],
    });
    expect(applied(cache.standings.setData, undefined)).toBeUndefined();
  });

  // After the end the page names the settled winner; a live push must not re-rank it.
  it('once ended: subscribes to nothing and ignores a push', () => {
    render(React.createElement(Teams, { enabled: false }));
    expect(signals.topics.filter((t) => t !== undefined)).toEqual([]);
    act(() => signals.handlers['event-points:teams'](push));
    expect(cache.standings.setData).not.toHaveBeenCalled();
  });
});
