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
  hubMark: vi.fn(async (_input: unknown) => 0),
  utils: undefined as unknown,
}));
h.utils = {
  hatTurf: {
    getStickersForImages: { fetch: vi.fn(async () => ({})) },
    getSummaries: { fetch: vi.fn(async () => ({ images: {} })) },
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
        useQueries: () => [],
        useUtils: () => h.utils,
      }
    ),
  };
});

import { cleanup } from 'vitest-browser-react';
import { TurfSummaryProvider, useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';
import { renderWithProviders } from '../../../../test/component-setup';

const probes: Record<string, ReturnType<typeof useTurfFeed>> = {};
function Probe({ name }: { name: string }) {
  probes[name] = useTurfFeed();
  return null;
}

// Two blocks on one page, as the home page mounts one ImagesProvider per block.
const mountPage = () =>
  renderWithProviders(
    <>
      <TurfSummaryProvider imageIds={[1, 2]}>
        <Probe name="a" />
      </TurfSummaryProvider>
      <TurfSummaryProvider imageIds={[2, 3]}>
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

const calls = (fn: { mock: { calls: unknown[][] } }) =>
  fn.mock.calls.map(([input]) => (input as { imageIds: number[] }).imageIds);

beforeEach(() => {
  h.mark.mockClear();
  h.hubMark.mockClear();
  vi.useFakeTimers();
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

  test('flag on: one mark for the page with the union of ids, re-marked once a minute', async () => {
    h.flags = { hatTurfBatchedCalls: true };
    await mountPage();
    const stops = watchCards();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls(h.hubMark)).toEqual([[1, 2, 3]]);
    expect(h.hubMark.mock.calls[0][0]).toEqual({ event: 'birthday2026', imageIds: [1, 2, 3] });
    // Not at 30s: the interval is a minute.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls(h.hubMark)).toEqual([[1, 2, 3]]);
    await vi.advanceTimersByTimeAsync(30_000);
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
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls(h.hubMark).at(-1)).toEqual([1, 2]);
    stopA1();
    stopB2();
  });

  test('flag on: unmounting the page stops the marks', async () => {
    h.flags = { hatTurfBatchedCalls: true };
    await mountPage();
    watchCards();
    await vi.advanceTimersByTimeAsync(1_000);
    cleanup();
    h.hubMark.mockClear();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.hubMark).not.toHaveBeenCalled();
  });
});
