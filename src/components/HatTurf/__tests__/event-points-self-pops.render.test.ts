// @vitest-environment happy-dom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

// "All" pops: the viewer's own total, watched and listened for only while event cosmetics are on and
// the setting is "All". Off, nothing at all: no watch call, no signal handler.

const { act } = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  cosmetics: true,
  joined: true,
  pops: 'all' as 'all' | 'active',
  watch: vi.fn(),
  onWatched: undefined as undefined | ((data: unknown) => void),
  onWatchFailed: undefined as undefined | (() => void),
  handlers: new Map<string, (data: unknown) => void>(),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'event.getCosmetic': { useQuery: () => ({ data: { obtained: h.joined } }) },
    'event.watchPoints': {
      useMutation: (opts: { onSuccess?: (d: unknown) => void; onError?: () => void }) => {
        h.onWatched = opts.onSuccess;
        h.onWatchFailed = opts.onError;
        return { mutate: h.watch };
      },
    },
  }),
}));
vi.mock('~/providers/BrowserSettingsProvider', () => ({
  useShowEventCosmetics: () => h.cosmetics,
  useBrowsingSettings: (pick: (s: { eventPointPops: string }) => unknown) =>
    pick({ eventPointPops: h.pops }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 5 }) }));
vi.mock('~/components/Decorations/usePlayableEventDecoration', () => ({
  usePlayableEventDecoration: (_t: string, enabled: boolean) =>
    enabled ? { event: 'birthday2026' } : undefined,
}));
vi.mock('~/components/Events/events.utils', () => ({ useTeamColor: () => () => undefined }));
vi.mock('~/components/Signals/SignalsProvider', () => ({
  useSignalConnection: (message: string, cb: (data: unknown) => void) =>
    h.handlers.set(message, cb),
}));

const { EventPointsSelfPops } = await import('~/components/HatTurf/EventPointsSelfPops');

let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => {
  h.cosmetics = true;
  h.joined = true;
  h.pops = 'all';
  h.watch.mockClear();
  h.handlers.clear();
  document.querySelectorAll('[data-testid="event-point-pop"]').forEach((el) => el.remove());
});
afterEach(() => act(() => root?.unmount()));

function mount() {
  root = createRoot(document.createElement('div'));
  act(() => root!.render(React.createElement(EventPointsSelfPops)));
}
const pops = () =>
  [...document.querySelectorAll('[data-testid="event-point-pop"]')].map((el) => el.textContent);
const push = (points: number) =>
  act(() => h.handlers.get('event-points:self')?.({ event: 'birthday2026', points }));

describe('EventPointsSelfPops', () => {
  it("pops the rise in the viewer's own total, never the whole total", () => {
    mount();
    expect(h.watch).toHaveBeenCalledWith({ event: 'birthday2026', topics: [], self: true });
    act(() => h.onWatched?.({ marked: 1, self: { points: 40, team: 'Yellow' } }));
    push(45);
    push(45);
    expect(pops()).toEqual(['+5 Yellow points']);
  });

  it('pops nothing before the watch has answered with a base', () => {
    mount();
    push(45);
    expect(pops()).toEqual([]);
  });

  describe('marks', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const shown = () => act(() => document.dispatchEvent(new Event('visibilitychange')));

    it('a tab shown again soon after its last mark sends none; the interval still renews it', () => {
      mount();
      expect(h.watch).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(5_000));
      shown();
      expect(h.watch).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(25_000));
      expect(h.watch).toHaveBeenCalledTimes(2);
      // Long enough after the last mark (20s), a tab shown again marks at once.
      act(() => vi.advanceTimersByTime(21_000));
      shown();
      expect(h.watch).toHaveBeenCalledTimes(3);
    });

    it('a failed mark does not hold back the next', () => {
      mount();
      act(() => h.onWatchFailed?.());
      shown();
      expect(h.watch).toHaveBeenCalledTimes(2);
    });
  });

  it.each([
    ['event cosmetics off', () => (h.cosmetics = false)],
    ['the setting on Active only', () => (h.pops = 'active')],
    ['a viewer who has not joined the event', () => (h.joined = false)],
  ])('with %s, watches nothing and listens for nothing', (_name, set) => {
    set();
    mount();
    expect(h.watch).not.toHaveBeenCalled();
    expect(h.handlers.size).toBe(0);
  });
});
