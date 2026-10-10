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
const topics: (string | undefined)[] = [];
const handlers = new Map<string, (raw: unknown) => void>();

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy(
      { 'event.watchPoints': { useMutation: () => ({ mutate }) } },
      { useUtils: () => ({ event: { getStandings: { setData: setStandings } } }) }
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

function Teams({ active }: { active: boolean }) {
  live.useEventTeamsLivePoints('birthday2026', active);
  return null;
}
const renderTeams = (active: boolean) =>
  act(() => root!.render(React.createElement(Teams, { active })));

describe('team totals', () => {
  it('in view: subscribes to the teams topic and marks it watched now and every 30s', () => {
    renderTeams(true);
    expect(topics.at(-1)).toBe('event-points:birthday2026:teams');
    expect(mutate.mock.calls).toEqual([[{ event: 'birthday2026', topics: ['teams'] }]]);
    act(() => vi.advanceTimersByTime(live.WATCH_REFRESH_MS));
    expect(mutate).toHaveBeenCalledTimes(2);
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

  it('a teams push re-ranks the standings the section renders', () => {
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
