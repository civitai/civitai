// @vitest-environment happy-dom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

/**
 * The client half of the interest set: a section that shows points subscribes to its topics and
 * marks them watched only while it is in view, and a teams push lands in the standings it renders.
 * The in-view flag is an input here; useInView itself is the shared IntersectionObserver hook.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mutate = vi.fn();
const setStandings = vi.fn();
// The tRPC proxy hands every hook the same utils object.
const topics: (string | undefined)[] = [];
const handlers = new Map<string, (raw: unknown) => void>();

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy(
      { 'event.watchPoints': { useMutation: () => ({ mutate }) } },
      {
        useUtils: () => ({
          event: { getStandings: { setData: setStandings }, getMyHats: { setData: vi.fn() } },
        }),
      }
    ),
  };
});
vi.mock('~/components/Signals/SignalsProvider', () => ({
  useSignalTopic: (topic: string | undefined) => void topics.push(topic),
  useSignalConnection: (message: string, cb: (raw: unknown) => void) =>
    void handlers.set(message, cb),
}));

const live = await import('~/components/Events/ScoredEvent/event-points-live');
const { SignalMessages } = await import('~/server/common/enums');

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  mutate.mockClear();
  setStandings.mockClear();
  topics.length = 0;
  handlers.clear();
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  vi.useRealTimers();
});

function Teams({ active, topicId = 'teams' }: { active: boolean; topicId?: string }) {
  live.useEventTeamsLivePoints('birthday2026', topicId, active);
  return null;
}
const renderTeams = (active: boolean, topicId?: string) =>
  act(() => root!.render(React.createElement(Teams, { active, topicId })));

describe('team totals', () => {
  it('in view: subscribes to the teams topic and marks it watched now and every 30s', () => {
    renderTeams(true);
    expect(topics.at(-1)).toBe('event-points:birthday2026:teams');
    expect(mutate.mock.calls).toEqual([[{ event: 'birthday2026', topics: ['teams'] }]]);
    act(() => vi.advanceTimersByTime(live.WATCH_REFRESH_MS));
    expect(mutate).toHaveBeenCalledTimes(2);
  });

  // In the preview the standings read hands out a keyed id; that is what is followed and marked.
  it('follows and marks the keyed id the read handed out, not the live one', () => {
    const keyed = 'ab'.repeat(16);
    renderTeams(true, keyed);
    expect(topics.at(-1)).toBe(`event-points:birthday2026:teams:${keyed}`);
    expect(mutate.mock.calls).toEqual([[{ event: 'birthday2026', topics: [keyed] }]]);
  });

  it('before the read has answered, neither subscribes nor marks', () => {
    act(() =>
      root!.render(
        React.createElement(function NoId() {
          live.useEventTeamsLivePoints('birthday2026', undefined, true);
          return null;
        })
      )
    );
    act(() => vi.advanceTimersByTime(live.WATCH_REFRESH_MS));
    expect(topics.every((t) => t === undefined)).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('out of view: unsubscribes and stops marking', () => {
    renderTeams(true);
    renderTeams(false);
    expect(topics.at(-1)).toBeUndefined();
    mutate.mockClear();
    act(() => vi.advanceTimersByTime(live.WATCH_REFRESH_MS * 3));
    expect(mutate).not.toHaveBeenCalled();
  });

  it('never in view: neither subscribes nor marks', () => {
    renderTeams(false);
    act(() => vi.advanceTimersByTime(live.WATCH_REFRESH_MS * 3));
    expect(topics.every((t) => t === undefined)).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('a teams push re-ranks the cached standings the section renders from', () => {
    renderTeams(true);
    act(() =>
      handlers.get(SignalMessages.EventPointsTeams)!({
        event: 'birthday2026',
        teams: { Blue: 50, Pink: 70 },
      })
    );
    const [input, update] = setStandings.mock.calls[0];
    expect(input).toEqual({ event: 'birthday2026' });
    const before = {
      teams: [
        { team: 'Blue', score: 40, rank: 1 },
        { team: 'Pink', score: 30, rank: 2 },
      ],
    };
    expect(update(before)).toEqual({
      teams: [
        { team: 'Pink', score: 70, rank: 1 },
        { team: 'Blue', score: 50, rank: 2 },
      ],
    });
  });
});

describe('top hats', () => {
  const ids = ['b'.padStart(16, '0'), 'a'.padStart(16, '0')];
  const renderTop = (topicIds: string[], inView: boolean) =>
    act(() =>
      root!.render(
        React.createElement(live.TopHatsLivePoints, { event: 'birthday2026', topicIds, inView })
      )
    );

  it('in view: subscribes and marks; a push re-sorts the cached top hats', () => {
    renderTop(ids, true);
    expect(topics.filter(Boolean).sort()).toEqual(
      ids.map((id) => `event-points:birthday2026:hat:${id}`).sort()
    );
    expect(mutate).toHaveBeenCalledTimes(1);
    act(() =>
      handlers.get(SignalMessages.EventPointsHat)!({
        event: 'birthday2026',
        topicId: ids[1],
        points: 9,
      })
    );
    const [input, update] = setStandings.mock.calls[0];
    expect(input).toEqual({ event: 'birthday2026' });
    expect(
      update({
        topCosmetics: [
          { topicId: ids[0], points: 5 },
          { topicId: ids[1], points: 1 },
        ],
      })
    ).toEqual({
      topCosmetics: [
        { topicId: ids[1], points: 9 },
        { topicId: ids[0], points: 5 },
      ],
    });
  });

  it('a re-ranked list is the same watch: no new mark', () => {
    renderTop(ids, true);
    renderTop([...ids].reverse(), true);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('out of view: subscribes to nothing and marks nothing', () => {
    renderTop(ids, false);
    act(() => vi.advanceTimersByTime(live.WATCH_REFRESH_MS * 2));
    expect(topics.filter(Boolean)).toEqual([]);
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('hat sections', () => {
  const ids = Array.from({ length: 60 }, (_, i) => i.toString(16).padStart(16, '0'));
  const renderHats = (inView: boolean) =>
    act(() =>
      root!.render(
        React.createElement(live.MyHatsLivePoints, { event: 'birthday2026', topicIds: ids, inView })
      )
    );

  it('in view: subscribes to every hat and marks them in batches of at most 50', () => {
    renderHats(true);
    expect(topics.filter(Boolean)).toHaveLength(60);
    expect(mutate.mock.calls.map(([arg]) => arg.topics.length)).toEqual([50, 10]);
    expect(mutate.mock.calls.flatMap(([arg]) => arg.topics)).toEqual(ids);
  });

  it('out of view: subscribes to nothing and marks nothing', () => {
    renderHats(false);
    act(() => vi.advanceTimersByTime(live.WATCH_REFRESH_MS * 2));
    expect(topics.filter(Boolean)).toEqual([]);
    expect(mutate).not.toHaveBeenCalled();
  });
});
