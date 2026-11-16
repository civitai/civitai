import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';
import type * as Trpc from '~/utils/trpc';

// `hatTurfBatchedCalls`: two TurfSummaryProviders on one page (two home blocks) send ONE watch mark
// per interval with the union of their on-screen ids. Off, each sends its own, every 30s.
const h = vi.hoisted(() => ({
  flags: null as { hatTurfBatchedCalls?: boolean } | null,
  // The per-provider path: useMutation's mutate.
  mark: vi.fn(),
  // The page-wide path: the hub calls the client directly.
  hubMark: vi.fn(async (_input: { event: string; imageIds: number[] }) => 0),
  // Catch-up reads, by provider chunk.
  fetchSummaries: vi.fn(async (_input: { imageIds: number[] }, _opts?: unknown) => ({
    images: {} as Record<number, unknown>,
  })),
  fetchStickers: vi.fn(async (_input: { imageIds: number[] }, _opts?: unknown) => ({})),
  // When every chunk's page read answered: long enough ago that counts and stickers are stale.
  stamp: 0,
  utils: undefined as unknown,
}));
h.utils = {
  hatTurf: {
    getStickersForImages: { fetch: h.fetchStickers },
    getSummaries: { fetch: h.fetchSummaries },
  },
  client: { hatTurf: { watch: { mutate: h.hubMark } } },
};

vi.mock('~/components/HatTurf/useHatTurfFeed', () => ({
  useHatTurfFeed: () => ({ event: 'birthday2026', arm: 'control' }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/components/Signals/SignalsProvider', () => ({
  useSignalTopic: () => undefined,
  useSignalConnection: () => undefined,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  useOptionalFeatureFlags: () => h.flags,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy(
      {
        'hatTurf.watch': { useMutation: () => ({ mutate: h.mark }) },
        'hatTurf.getStock': {
          useQuery: () => ({ data: { available: 3, optedIn: true } }),
        },
      },
      {
        // Every chunk answered at `h.stamp`: an empty standings read, or no stickers.
        useQueries: (build: (t: unknown) => { proc: string }[]) => {
          const t = new Proxy(
            {},
            {
              get: () =>
                new Proxy({}, { get: (_b, proc: string) => (input: unknown) => ({ proc, input }) }),
            }
          );
          return build(t).map(({ proc }) => ({
            dataUpdatedAt: h.stamp,
            data: proc === 'getSummaries' ? { team: 'blue', images: {}, open: {}, hidden: {} } : {},
          }));
        },
        useUtils: () => h.utils,
      }
    ),
  };
});

import { cleanup } from 'vitest-browser-react';
import { TurfSummaryProvider, useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';
import { retainTurfWatchHub } from '~/components/HatTurf/turf-watch-hub';
import { renderWithProviders } from '../../../../test/component-setup';

const probes: Record<string, ReturnType<typeof useTurfFeed>> = {};
function Probe({ name }: { name: string }) {
  probes[name] = useTurfFeed();
  return null;
}

// Two blocks on one page, as the home page mounts one ImagesProvider per block.
const mountPage = (a = [1, 2], b = [2, 3]) =>
  renderWithProviders(
    <>
      <TurfSummaryProvider imageIds={a}>
        <Probe name="a" />
      </TurfSummaryProvider>
      <TurfSummaryProvider imageIds={b}>
        <Probe name="b" />
      </TurfSummaryProvider>
    </>
  );

const watchCards = () => [
  probes.a!.watch(1),
  probes.a!.watch(2),
  probes.b!.watch(2),
  probes.b!.watch(3),
];

/**
 * The page's hub for `event` right now, read through the registry and held only for this call. It is
 * the same object while a provider still holds that hub, and a new one once the last holder has
 * released (and so disposed) it.
 */
const currentHub = (event: string) => {
  const held = retainTurfWatchHub({
    event,
    send: () => undefined,
    refreshMs: 40_000,
    coalesceMs: 250,
    minGapMs: 2_000,
    retryMs: 5_000,
    retryJitterMs: 1_000,
    onVisible: () => () => undefined,
  });
  held.release();
  return held.hub;
};

const setVisibility = async (state: 'visible' | 'hidden') => {
  // Pinned, so the test does not depend on whether the test browser's page counts as visible.
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  try {
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(100);
  } finally {
    // Back to the prototype's getter.
    delete (document as { visibilityState?: unknown }).visibilityState;
  }
};

const calls = (fn: { mock: { calls: unknown[][] } }) =>
  fn.mock.calls.map(([input]) => (input as { imageIds: number[] }).imageIds);
const sortedCalls = (fn: { mock: { calls: unknown[][] } }) =>
  calls(fn)
    .map((ids) => [...ids].sort((x, y) => x - y))
    .sort((x, y) => x[0] - y[0]);

beforeEach(() => {
  h.mark.mockClear();
  h.hubMark.mockReset();
  h.hubMark.mockImplementation(async () => 0);
  h.fetchSummaries.mockClear();
  h.fetchStickers.mockClear();
  vi.useFakeTimers();
  // Two minutes old: past both catch-up thresholds (30s counts, 90s stickers).
  h.stamp = Date.now() - 120_000;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('TurfSummaryProvider watch marks', () => {
  test('flag off: each provider marks its own cards, and re-marks them every 30s', async () => {
    h.flags = { hatTurfBatchedCalls: false };
    await mountPage();
    const stops = watchCards();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls(h.mark)).toEqual([
      [1, 2],
      [2, 3],
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls(h.mark)).toEqual([
      [1, 2],
      [2, 3],
      [1, 2],
      [2, 3],
    ]);
    expect(h.hubMark).not.toHaveBeenCalled();
    stops.forEach((stop) => stop());
  });

  test('no flags provider at all: the old per-provider marks', async () => {
    h.flags = null;
    await mountPage();
    const stops = watchCards();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls(h.mark)).toEqual([
      [1, 2],
      [2, 3],
    ]);
    expect(h.hubMark).not.toHaveBeenCalled();
    stops.forEach((stop) => stop());
  });

  test('flag on: one mark for the page with the union of ids, re-marked every 40s', async () => {
    h.flags = { hatTurfBatchedCalls: true };
    await mountPage();
    const stops = watchCards();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls(h.hubMark)).toEqual([[1, 2, 3]]);
    expect(h.hubMark.mock.calls[0][0]).toEqual({ event: 'birthday2026', imageIds: [1, 2, 3] });
    // Not at 30s (the old interval): the hub's is 40s, counted from mount.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls(h.hubMark)).toEqual([[1, 2, 3]]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls(h.hubMark)).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ]);
    expect(h.mark).not.toHaveBeenCalled();
    stops.forEach((stop) => stop());
  });

  test('flag on: an id one block lets go stays marked while the other still shows it', async () => {
    h.flags = { hatTurfBatchedCalls: true };
    await mountPage();
    const [stopA1, stopA2, stopB2, stopB3] = watchCards();
    await vi.advanceTimersByTimeAsync(1_000);
    stopA2();
    stopB3();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(calls(h.hubMark).at(-1)).toEqual([1, 2]);
    stopA1();
    stopB2();
  });

  test('flag on: unmounting the page disposes its hub, with cards still watching', async () => {
    h.flags = { hatTurfBatchedCalls: true };
    await mountPage();
    // Never stopped: the cards are still on screen when the page goes.
    watchCards();
    await vi.advanceTimersByTimeAsync(1_000);
    const before = currentHub('birthday2026');
    expect(before.watched()).toEqual([1, 2, 3]);
    cleanup();
    h.hubMark.mockClear();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.hubMark).not.toHaveBeenCalled();
    // A leaked hub would still be registered (and returned here); a disposed one is gone.
    expect(currentHub('birthday2026')).not.toBe(before);
  });

  test('flag on: ids marked again go to every provider, and each reads only its own', async () => {
    h.flags = { hatTurfBatchedCalls: true };
    // Disjoint blocks: 1 and 2 in the first, 3 and 4 in the second.
    await mountPage([1, 2], [3, 4]);
    let stopA = probes.a!.watch(1);
    let stopB = probes.b!.watch(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.fetchSummaries).not.toHaveBeenCalled();
    // Both scroll off, then back (a virtualized feed).
    stopA();
    stopB();
    await vi.advanceTimersByTimeAsync(3_000);
    stopA = probes.a!.watch(1);
    stopB = probes.b!.watch(3);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls(h.hubMark)).toEqual([
      [1, 3],
      [1, 3],
    ]);
    // The hub told both providers [1, 3]; each read only the id its own chunk holds.
    expect(sortedCalls(h.fetchSummaries)).toEqual([[1], [3]]);
    expect(sortedCalls(h.fetchStickers)).toEqual([[1], [3]]);
    stopA();
    stopB();
  });

  test('flag on: page visible again re-marks the whole set once and catches every id up', async () => {
    h.flags = { hatTurfBatchedCalls: true };
    await mountPage([1, 2], [3]);
    const stops = [probes.a!.watch(1), probes.a!.watch(2), probes.b!.watch(3)];
    await vi.advanceTimersByTimeAsync(1_000);
    h.hubMark.mockClear();
    await setVisibility('visible');
    expect(h.hubMark.mock.calls.map(([input]) => input)).toEqual([
      { event: 'birthday2026', imageIds: [1, 2, 3] },
    ]);
    expect(sortedCalls(h.fetchSummaries)).toEqual([[1, 2], [3]]);
    stops.forEach((stop) => stop());
  });

  // The negative control for the case above: going hidden is a visibilitychange too.
  test('flag on: page going hidden re-marks nothing and reads nothing', async () => {
    h.flags = { hatTurfBatchedCalls: true };
    await mountPage([1, 2], [3]);
    const stops = [probes.a!.watch(1), probes.a!.watch(2), probes.b!.watch(3)];
    await vi.advanceTimersByTimeAsync(1_000);
    h.hubMark.mockClear();
    await setVisibility('hidden');
    expect(h.hubMark).not.toHaveBeenCalled();
    expect(h.fetchSummaries).not.toHaveBeenCalled();
    expect(h.fetchStickers).not.toHaveBeenCalled();
    stops.forEach((stop) => stop());
  });

  test('flag on: one failed mark is retried exactly once', async () => {
    h.flags = { hatTurfBatchedCalls: true };
    h.hubMark.mockRejectedValue(new Error('down'));
    await mountPage([1, 2], [3]);
    const stops = [probes.a!.watch(1), probes.b!.watch(3)];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls(h.hubMark)).toEqual([[1, 3]]);
    // Retried 5s to 6s after the failure; the retry fails too and is not retried.
    await vi.advanceTimersByTimeAsync(7_000);
    expect(calls(h.hubMark)).toEqual([
      [1, 3],
      [1, 3],
    ]);
    // Still two until the 40s interval.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls(h.hubMark)).toEqual([
      [1, 3],
      [1, 3],
    ]);
    stops.forEach((stop) => stop());
  });

  test('flag on: an event change disposes the old hub and marks under the new one', async () => {
    h.flags = { hatTurfBatchedCalls: true };
    const tree = (event: string) => (
      <TurfSummaryProvider imageIds={[1, 2]} gate={{ event }}>
        <Probe name="a" />
      </TurfSummaryProvider>
    );
    const screen = await renderWithProviders(tree('event-one'));
    // Never stopped before the change: the cards stay on screen across it.
    const stops = [probes.a!.watch(1), probes.a!.watch(2)];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.hubMark.mock.calls.map(([input]) => input)).toEqual([
      { event: 'event-one', imageIds: [1, 2] },
    ]);
    const oldHub = currentHub('event-one');
    await screen.rerender(tree('event-two'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.hubMark.mock.calls.map(([input]) => input)).toEqual([
      { event: 'event-one', imageIds: [1, 2] },
      { event: 'event-two', imageIds: [1, 2] },
    ]);
    // The old hub's interval is gone: only the new event is re-marked.
    h.hubMark.mockClear();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.hubMark.mock.calls.map(([input]) => input)).toEqual([
      { event: 'event-two', imageIds: [1, 2] },
    ]);
    // Disposed, not leaked: the registry no longer hands out the old event's hub.
    expect(currentHub('event-one')).not.toBe(oldHub);
    expect(currentHub('event-two').watched()).toEqual([1, 2]);
    stops.forEach((stop) => stop());
  });
});
