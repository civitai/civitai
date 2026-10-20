// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StickerPlacementBatchProvider,
  useStickerPlacementBatch,
} from '~/components/Sticker/StickerPlacementBatchProvider';
import { useForgetStickerPlacement } from '~/components/Sticker/placement.util';
import { useStickerRevealStore } from '~/store/sticker-reveal.store';
import { getQueryKey } from '@trpc/react-query';
import { queryClient, trpc } from '~/utils/trpc';

/**
 * 🔴 HOW MANY PLACEMENT CALLS A SURFACE MAKES, counted on the wire.
 *
 * The REAL tRPC client runs (nothing in `~/utils/trpc` is mocked) with only `fetch` stubbed, so
 * what is counted is the requests the provider actually issues — the same thing the per-procedure
 * call rate in production counts. A surface used to ask for its counts and its placements as two
 * calls per 100 cards; for a viewer who wants placements it now asks once.
 *
 * Fixture discipline: every image's count and placement id is distinct from every other image's,
 * so a value landing on the wrong card cannot pass by colliding with the right one.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = { user: null as { id: number } | null };

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => session.user }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ stickers: true, stickerPlacement: true }),
}));
// Reads the router and the viewer's settings; neither is what is measured here.
vi.mock('~/components/Sticker/treatments/useStickerTreatment', () => ({
  useStickerTreatment: () => 'none',
}));

/** 150 ids: two chunks at the 100 cap, so "one call per chunk" is distinguishable from one call. */
const IDS = Array.from({ length: 150 }, (_, index) => 1000 + index);
const countOf = (imageId: number) => (imageId % 7) + 2;
const placementOf = (imageId: number) => ({
  id: imageId * 10 + 3,
  imageId,
  placerId: 52,
  ownerId: 41,
  status: 'approved',
  amount: 700,
  free: false,
  data: { cosmeticId: 85, x: 0.5, y: 0.5, scale: 0.2, rotation: 0 },
  placedAt: '2026-10-01T00:00:00.000Z',
  isPending: false,
  hasComment: false,
});

type Request = { path: string; imageIds: number[] };
const requests: Request[] = [];
/** Held responses, for the test that needs a request to still be in flight. */
let hold: ((path: string) => Promise<void> | undefined) | undefined;

const answer = (path: string, imageIds: number[]) => {
  switch (path) {
    case 'placement.getStickerPlacementCounts':
      return Object.fromEntries(imageIds.map((id) => [id, countOf(id)]));
    case 'placement.getStickerPlacements':
      return imageIds.map(placementOf);
    case 'placement.getStickerPlacementsAndCounts':
      return {
        placements: imageIds.map(placementOf),
        counts: Object.fromEntries(imageIds.map((id) => [id, countOf(id)])),
      };
    default:
      return [];
  }
};

function stubFetch() {
  requests.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://test');
      const path = url.pathname.replace('/api/trpc/', '');
      const raw = url.searchParams.get('input');
      const imageIds: number[] = raw ? JSON.parse(raw).json?.imageIds ?? [] : [];
      if (path.startsWith('placement.')) requests.push({ path, imageIds });
      await hold?.(path);
      return new Response(JSON.stringify({ result: { data: { json: answer(path, imageIds) } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
}

const seen = new Map<number, { count: number; placementIds: number[] }>();
let forget: ((placementId: number) => Promise<void>) | undefined;

function Card({ imageId }: { imageId: number }) {
  const batch = useStickerPlacementBatch(imageId);
  if (batch)
    seen.set(imageId, {
      count: batch.count,
      placementIds: batch.placements.map((placement) => placement.id),
    });
  return null;
}

function Forgetter() {
  forget = useForgetStickerPlacement();
  return null;
}

// Its `children` prop is required by type, and lint forbids passing it as a prop — so the
// provider is reached through a props type that leaves it to `createElement`'s third argument.
const Provider = StickerPlacementBatchProvider as unknown as ComponentType<{ imageIds: number[] }>;

function Surface() {
  return createElement(
    Provider,
    { imageIds: IDS },
    createElement(
      Fragment,
      null,
      createElement(Forgetter),
      ...IDS.map((imageId) => createElement(Card, { imageId, key: imageId }))
    )
  );
}

let root: Root | undefined;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

async function renderSurface() {
  queryClient.clear();
  const Wrapped = trpc.withTRPC(Surface as never) as unknown as ComponentType<{
    pageProps: object;
  }>;
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root?.render(createElement(Wrapped, { pageProps: {} }));
  });
  await settle();
}

const byPath = () =>
  requests.reduce<Record<string, number>>((tally, request) => {
    tally[request.path] = (tally[request.path] ?? 0) + 1;
    return tally;
  }, {});

beforeEach(() => {
  seen.clear();
  hold = undefined;
  session.user = null;
  useStickerRevealStore.setState({ revealed: false, forced: 0, forcedDismissed: false });
  stubFetch();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('a signed-in surface asks once per chunk', () => {
  it('makes one combined call per 100 cards, and neither of the two it replaces', async () => {
    session.user = { id: 7 };
    await renderSurface();

    expect(byPath()).toEqual({ 'placement.getStickerPlacementsAndCounts': 2 });
    // Every id asked for exactly once across the chunks.
    expect(requests.flatMap((request) => request.imageIds).sort()).toEqual([...IDS].sort());
  });

  it("gives every card its own count and placements, not a neighbour's", async () => {
    session.user = { id: 7 };
    await renderSurface();

    // One from each chunk, plus the boundary either side of the cut.
    for (const imageId of [1000, 1099, 1100, 1149])
      expect(seen.get(imageId)).toEqual({
        count: countOf(imageId),
        placementIds: [placementOf(imageId).id],
      });
  });
});

describe('an anonymous surface with stickers hidden', () => {
  // INVARIANT GUARD, not regression coverage: this behaviour is unchanged, and pinned so the
  // combined call cannot quietly become the anonymous path too. The count-only response is the
  // one a shared cache answers, and a combined URL would be a cold cache for every visitor.
  it('keeps the count-only call, one per chunk, and asks for no placements', async () => {
    await renderSurface();

    expect(byPath()).toEqual({ 'placement.getStickerPlacementCounts': 2 });
    expect(seen.get(1100)).toEqual({ count: countOf(1100), placementIds: [] });
  });

  it('keeps the count on screen while revealing switches it to the combined call', async () => {
    await renderSurface();
    expect(seen.get(1042)?.count).toBe(countOf(1042));

    // The combined call is held in flight: this is the moment a count read only from it would
    // drop to nothing.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    hold = (path) => (path === 'placement.getStickerPlacementsAndCounts' ? gate : undefined);

    await act(async () => {
      useStickerRevealStore.setState({ revealed: true });
    });
    await settle();

    expect(byPath()['placement.getStickerPlacementsAndCounts']).toBe(2);
    expect(seen.get(1042)).toEqual({ count: countOf(1042), placementIds: [] });

    release();
    await settle();
    expect(seen.get(1042)).toEqual({
      count: countOf(1042),
      placementIds: [placementOf(1042).id],
    });
  });
});

describe('removing a placement', () => {
  it('drops it, and one from its count, on the card that held it and no other', async () => {
    session.user = { id: 7 };
    await renderSurface();
    const callsBefore = requests.length;
    // A count-only entry for the same images, as an earlier signed-out view of them leaves behind.
    const countOnlyKey = getQueryKey(
      trpc.placement.getStickerPlacementCounts,
      { imageIds: [1120, 1121] },
      'query'
    );
    queryClient.setQueryData(countOnlyKey, { 1120: 5, 1121: 6 });

    await act(async () => {
      await forget?.(placementOf(1120).id);
    });
    await settle();

    expect(seen.get(1120)).toEqual({ count: countOf(1120) - 1, placementIds: [] });
    // That entry loses the same one, for the removed row's image only.
    expect(queryClient.getQueryData(countOnlyKey)).toEqual({ 1120: 4, 1121: 6 });
    // A neighbour in the same chunk, and one in the other chunk, are untouched.
    expect(seen.get(1121)).toEqual({
      count: countOf(1121),
      placementIds: [placementOf(1121).id],
    });
    expect(seen.get(1010)).toEqual({
      count: countOf(1010),
      placementIds: [placementOf(1010).id],
    });
    // Without refetching the surface to do it (the detail invalidation is not a placement listing).
    expect(
      requests
        .slice(callsBefore)
        .filter((request) => request.path !== 'placement.getStickerPlacementDetail')
    ).toEqual([]);
  });
});
