import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';

const h = vi.hoisted(() => ({
  gate: { event: 'birthday2026', arm: 'control' } as {
    event: string;
    arm: 'control' | 'badge-popover';
  } | null,
  asked: [] as { proc: string; input: any }[],
  mark: vi.fn(),
  fetch: vi.fn(async () => ({} as Record<number, unknown[]>)),
  push: undefined as undefined | ((raw: unknown) => void),
  // Every mounted provider's push handler: one per simulated viewer.
  viewers: new Set<(raw: unknown) => void>(),
  utils: undefined as unknown,
  user: { id: 1 } as { id: number } | null,
  stock: { available: 3, optedIn: true } as { available: number; optedIn: boolean } | undefined,
  // A cached stock answer survives a disabled query (react-query keeps data), so the gate must not
  // trust it alone: rows set this to answer even when the provider disables the read.
  stockIgnoresEnabled: false,
}));
h.utils = { hatTurf: { getStickersForImages: { fetch: h.fetch } } };

const summary = (leader: string, hatted = false) => ({
  shown: { blue: 2, pink: 1 },
  counted: { blue: 2, pink: 1 },
  leader,
  leaderCosmeticId: 11,
  hatted,
});

vi.mock('~/components/HatTurf/useHatTurfFeed', () => ({ useHatTurfFeed: () => h.gate }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => h.user }));
vi.mock('~/components/Signals/SignalsProvider', () => ({
  useSignalTopic: () => undefined,
  useSignalConnection: (_message: string, cb: (raw: unknown) => void) => {
    h.push = cb;
    h.viewers.add(cb);
  },
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy(
      {
        'hatTurf.watch': { useMutation: () => ({ mutate: h.mark }) },
        'hatTurf.getStock': {
          useQuery: (_input: unknown, opts: { enabled?: boolean }) => ({
            data: opts.enabled === false && !h.stockIgnoresEnabled ? undefined : h.stock,
          }),
        },
      },
      {
        // Answer each chunk's query by the procedure and input the provider asked for.
        useQueries: (build: (t: unknown) => { proc: string; input: any }[]) => {
          const t = new Proxy(
            {},
            {
              get: (_a, _router) =>
                new Proxy(
                  {},
                  {
                    get: (_b, proc: string) => (input: any) => ({ proc, input }),
                  }
                ),
            }
          );
          const asked = build(t);
          h.asked.push(...asked);
          return asked.map(({ proc, input }, i) => ({
            dataUpdatedAt: 1 + i,
            data:
              proc === 'getSummaries'
                ? {
                    team: 'blue',
                    images: Object.fromEntries(
                      input.imageIds
                        .filter((id: number) => id % 2 === 1)
                        .map((id: number) => [id, summary('blue', id === 1)])
                    ),
                    open: Object.fromEntries(input.imageIds.map((id: number) => [id, id !== 4])),
                    hidden: input.imageIds.includes(6) ? { 6: true } : {},
                  }
                : Object.fromEntries(
                    input.imageIds.map((id: number) => [
                      id,
                      [
                        {
                          id: id * 10,
                          userId: 9,
                          team: 'blue',
                          cosmeticId: 11,
                          data: { x: 0.5, y: 0.5 },
                        },
                      ],
                    ])
                  ),
          }));
        },
        useUtils: () => h.utils,
      }
    ),
  };
});

import { act } from 'react';
import { cleanup } from 'vitest-browser-react';
import { TurfSummaryProvider, useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';
import { renderWithProviders } from '../../../../test/component-setup';

let latest: ReturnType<typeof useTurfFeed> = null;
function Probe() {
  latest = useTurfFeed();
  return <span data-testid="probe">{latest ? 'on' : 'off'}</span>;
}

const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);
const tree = (imageIds: number[]) => (
  <TurfSummaryProvider imageIds={imageIds}>
    <Probe />
  </TurfSummaryProvider>
);
const mount = (imageIds: number[]) =>
  renderWithProviders(
    <TurfSummaryProvider imageIds={imageIds}>
      <Probe />
    </TurfSummaryProvider>
  );

beforeEach(() => {
  h.gate = { event: 'birthday2026', arm: 'control' };
  h.user = { id: 1 };
  h.stock = { available: 3, optedIn: true };
  h.stockIgnoresEnabled = false;
  h.asked = [];
  h.mark.mockClear();
  h.fetch.mockClear();
  h.viewers.clear();
  latest = null;
});
afterEach(() => cleanup());

describe('TurfSummaryProvider', () => {
  test('asks once per 100 cards for standings and for hats, and merges every chunk', async () => {
    await mount(ids(150));
    // Every render asks again; what matters is the distinct requests.
    const distinct = [...new Map(h.asked.map((a) => [JSON.stringify(a), a])).values()];
    const summaries = distinct.filter((a) => a.proc === 'getSummaries');
    const hats = distinct.filter((a) => a.proc === 'getStickersForImages');
    expect(summaries.map((a) => a.input.imageIds.length)).toEqual([100, 50]);
    expect(hats.map((a) => a.input.imageIds.length)).toEqual([100, 50]);
    expect(hats.every((a) => a.input.perImage === 5)).toBe(true);
    expect(latest!.team).toBe('blue');
    // Odd ids have turf, from either chunk; image 4 is not open.
    expect(Object.keys(latest!.images).length).toBe(75);
    expect(latest!.images[149]).toBeDefined();
    expect(latest!.open[4]).toBe(false);
    expect(latest!.open[5]).toBe(true);
    expect(latest!.stickers[120]).toHaveLength(1);
  });

  test('hands the viewer’s arm to the cards', async () => {
    h.gate = { event: 'birthday2026', arm: 'badge-popover' };
    await mount(ids(3));
    await vi.waitFor(() => expect(latest?.arm).toBe('badge-popover'));
  });

  test('asks nothing, and offers no context, with Hat Turf off', async () => {
    h.gate = null;
    await mount(ids(3));
    expect(h.asked).toEqual([]);
    expect(latest).toBeNull();
  });

  // Only a viewer who joined Hat Turf sees turf. The
  // others keep the context (the join invite needs it) but get no hats, counts or pushes. The joined
  // row is the positive control for the rest.
  test.each([
    { who: 'joined', user: { id: 1 }, stock: { available: 3, optedIn: true }, joined: true },
    { who: 'not joined', user: { id: 1 }, stock: { available: 3, optedIn: false }, joined: false },
    { who: 'stock not loaded', user: { id: 1 }, stock: undefined, joined: false },
    // Stock that says joined, served even though the read is disabled: only the signed-in check can
    // keep turf hidden here.
    {
      who: 'signed out',
      user: null,
      stock: { available: 3, optedIn: true },
      joined: false,
      cached: true,
    },
  ])('$who: hats, counts and pushes only when joined', async ({ user, stock, joined, ...row }) => {
    h.user = user;
    h.stock = stock;
    h.stockIgnoresEnabled = 'cached' in row;
    await mount([1, 3]);
    await vi.waitFor(() => expect(latest).not.toBeNull());
    const procs = new Set(h.asked.map((a) => a.proc));
    expect(procs.has('getSummaries')).toBe(true);
    expect(procs.has('getStickersForImages')).toBe(joined);
    expect(Object.keys(latest!.images).length).toBe(joined ? 2 : 0);
    expect(Object.keys(latest!.stickers).length).toBe(joined ? 2 : 0);
    expect(h.viewers.size).toBe(joined ? 1 : 0);
    expect(latest!.joined).toBe(joined);
  });

  test('a push replaces the image’s counts, keeps hatted, and reads its hats back once', async () => {
    await mount([1, 3]);
    expect(latest!.images[1].hatted).toBe(true);
    const counts = {
      shown: { pink: 5 },
      counted: { pink: 5 },
      leader: 'pink',
      leaderCosmeticId: 12,
    };
    act(() => h.push!({ event: 'birthday2026', imageId: 1, counts }));
    act(() => h.push!({ event: 'birthday2026', imageId: 1, counts }));
    await vi.waitFor(() => expect(latest!.images[1].leader).toBe('pink'));
    expect(latest!.images[1].hatted).toBe(true);
    expect(latest!.images[3].leader).toBe('blue');
    await vi.waitFor(() =>
      expect(h.fetch).toHaveBeenCalledWith({ event: 'birthday2026', imageIds: [1], perImage: 5 })
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  test('a contest entry (hidden) keeps no hats and no counts, even from a push', async () => {
    await mount([5, 6]);
    await vi.waitFor(() => expect(latest!.stickers[5]).toBeDefined());
    expect(latest!.hidden).toEqual({ 6: true });
    expect(latest!.stickers[6]).toBeUndefined();
    const counts = {
      shown: { pink: 5 },
      counted: { pink: 5 },
      leader: 'pink',
      leaderCosmeticId: 12,
    };
    act(() => h.push!({ event: 'birthday2026', imageId: 6, counts }));
    act(() => h.push!({ event: 'birthday2026', imageId: 5, counts }));
    await vi.waitFor(() => expect(latest!.images[5].leader).toBe('pink'));
    expect(latest!.images[6]).toBeUndefined();
  });

  test('loading another page does not wipe the pushes already applied to the first', async () => {
    const view = await mount(ids(100));
    act(() =>
      h.push!({
        event: 'birthday2026',
        imageId: 5,
        counts: { shown: { pink: 5 }, counted: { pink: 5 }, leader: 'pink', leaderCosmeticId: 12 },
      })
    );
    await vi.waitFor(() => expect(latest!.images[5].leader).toBe('pink'));
    await view.rerender(tree(ids(150)));
    await vi.waitFor(() => expect(latest!.images[149]).toBeDefined());
    expect(latest!.images[5].leader).toBe('pink');
  });

  test('a push for the last sticker leaving removes the image’s turf', async () => {
    await mount([1, 3]);
    act(() => h.push!({ event: 'birthday2026', imageId: 3, counts: null }));
    await vi.waitFor(() => expect(latest!.images[3]).toBeUndefined());
    expect(latest!.images[1]).toBeDefined();
  });

  test('ignores a push for another event or a malformed one', async () => {
    await mount([1]);
    act(() => h.push!({ event: 'other', imageId: 1, counts: null }));
    act(() => h.push!({ event: 'birthday2026', imageId: 'x', counts: {} }));
    await new Promise((r) => setTimeout(r, 100));
    expect(latest!.images[1]).toBeDefined();
  });

  test('marks the cards that say they are on screen, in batches of 50', async () => {
    await mount([1]);
    const stops = ids(120).map((id) => latest!.watch(id));
    await vi.waitFor(() => expect(h.mark).toHaveBeenCalled());
    const last = h.mark.mock.calls.slice(-3).map(([arg]) => arg.imageIds.length);
    expect(last).toEqual([50, 50, 20]);
    stops.forEach((stop) => stop());
  });

  test('cards mounting over a scroll burst are marked in one request', async () => {
    vi.useFakeTimers();
    try {
      await mount([1]);
      const stops: (() => void)[] = [];
      for (const id of [11, 12, 13, 14, 15]) {
        stops.push(latest!.watch(id));
        await vi.advanceTimersByTimeAsync(20);
      }
      expect(h.mark).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.mark.mock.calls.map(([arg]) => arg.imageIds)).toEqual([[11, 12, 13, 14, 15]]);
      stops.forEach((stop) => stop());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('one hot image: K viewers × P pushes', () => {
  const K = 20;
  const P = 10;
  const HOT = 7;
  const counts = { shown: { pink: 5 }, counted: { pink: 5 }, leader: 'pink', leaderCosmeticId: 12 };
  const pushed = [{ id: '70', userId: 3, team: 'pink', cosmeticId: 12, data: { x: 0.2, y: 0.3 } }];

  let probes: ReturnType<typeof useTurfFeed>[] = [];
  function Viewer({ n }: { n: number }) {
    probes[n] = useTurfFeed();
    return null;
  }
  const mountViewers = () =>
    renderWithProviders(
      <>
        {ids(K, 0).map((n) => (
          <TurfSummaryProvider key={n} imageIds={[HOT]}>
            <Viewer n={n} />
          </TurfSummaryProvider>
        ))}
      </>
    );
  // Each push 1s after the last: past main's 800ms debounce, so main reads once per push per viewer.
  const firePushes = async (extra: (p: number) => Record<string, unknown>) => {
    for (let p = 0; p < P; p++) {
      act(() =>
        h.viewers.forEach((cb) => cb({ event: 'birthday2026', imageId: HOT, counts, ...extra(p) }))
      );
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await vi.advanceTimersByTimeAsync(30_000);
  };

  beforeEach(() => {
    probes = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  // Before this fix every viewer read on every push: 200 reads here, K × P.
  test('pushes that carry the stickers cost no reads, and every viewer draws them', async () => {
    await mountViewers();
    expect(h.viewers.size).toBe(K);
    await firePushes(() => ({ stickers: pushed }));
    expect(h.fetch).toHaveBeenCalledTimes(0);
    await vi.waitFor(() =>
      expect(probes.map((v) => v!.stickers[HOT])).toEqual(Array(K).fill(pushed))
    );
  });

  test('pushes without stickers (an older server) read at most once per 10s per viewer', async () => {
    await mountViewers();
    expect(h.viewers.size).toBe(K);
    await firePushes(() => ({}));
    // P pushes over ~10s: the first read, then one trailing read after the 10s floor (not dropped:
    // the last pushes' hats must still be read).
    expect(h.fetch).toHaveBeenCalledTimes(2 * K);
  });
});

describe('stickers a push carries', () => {
  const counts = { shown: { pink: 5 }, counted: { pink: 5 }, leader: 'pink', leaderCosmeticId: 12 };
  const hat = [{ id: '1', userId: 3, team: 'pink', cosmeticId: 12, data: {} }];
  const send = (extra: Record<string, unknown>) =>
    act(() => h.push!({ event: 'birthday2026', imageId: 1, counts, ...extra }));

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('a push whose stickers are null keeps what is drawn, and reads nothing', async () => {
    await mount([1]);
    send({ stickers: hat });
    send({ stickers: null });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(latest!.stickers[1]).toEqual(hat);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  test('a read already in flight does not undo a push that landed during it', async () => {
    let answer!: (v: Record<number, unknown[]>) => void;
    h.fetch.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    await mount([1]);
    send({}); // an older server's push: schedules a read
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    send({ stickers: hat });
    await act(async () => answer({ 1: [] }));
    expect(latest!.stickers[1]).toEqual(hat);
  });

  test('a push with stickers cancels a read an older push scheduled', async () => {
    await mount([1]);
    send({}); // an older server's push: schedules a read
    send({ stickers: hat });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(latest!.stickers[1]).toEqual(hat);
  });
});
