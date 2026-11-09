// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { useRemixGalleryBatch } from '~/components/RemixGallery/RemixGalleryBatchProvider';
import { useStickerPlacementBatch } from '~/components/Sticker/StickerPlacementBatchProvider';
import { useForgetStickerPlacement } from '~/components/Sticker/placement.util';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import { useStickerRevealStore } from '~/store/sticker-reveal.store';
import { queryClient, trpc } from '~/utils/trpc';

/**
 * 🔴 HOW MANY PLACEMENT CALLS A FEED SURFACE MAKES, with and without `placementCardFold`, counted
 * on the wire through the REAL `ImagesProvider` (only `fetch` is stubbed and the two sibling
 * providers that are not placement reads are passed through).
 *
 * Off, a surface asks for its sticker data and its remix-gallery summaries as one call each per
 * 100 cards. On, it asks once per 100 cards for both — and every card must read the same values
 * either way. Per-image values are pairwise distinct, and the sticker and remix ranges do not
 * overlap, so a value on the wrong card or in the wrong half cannot pass by collision.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = { user: null as { id: number } | null };
const flags = { current: {} as Record<string, boolean> };

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => session.user }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProvider>()),
  useFeatureFlags: () => flags.current,
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useViewerBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/Sticker/treatments/useStickerTreatment', () => ({
  useStickerTreatment: () => 'none',
}));
// Not placement reads, and not what is counted here.
vi.mock('~/components/HatTurf/TurfSummaryProvider', () => ({
  TurfSummaryProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('~/components/Storyline/StorylineBatchProvider', () => ({
  StorylineBatchProvider: ({ children }: { children: unknown }) => children,
}));

/** 150 ids: two chunks at the 100 cap, so "one call per chunk" is distinguishable from one call. */
const IDS = Array.from({ length: 150 }, (_, index) => 1000 + index);
const IMAGES = IDS.map((id) => ({ id, postId: id + 5000 }));
const countOf = (imageId: number) => (imageId - 1000) * 2 + 3;
const remixCountOf = (imageId: number) => imageId * 10 + 1;
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

const counts = (ids: number[]) => Object.fromEntries(ids.map((id) => [id, countOf(id)]));
const bundle = (ids: number[]) => ({ placements: ids.map(placementOf), counts: counts(ids) });
const remix = (ids: number[]) =>
  Object.fromEntries(ids.map((id) => [id, { count: remixCountOf(id), entries: [] }]));

type Input = { imageIds?: number[]; stickers?: string; remix?: boolean };
type Request = { path: string; input: Input };
const requests: Request[] = [];
let hold: ((request: Request) => Promise<void> | undefined) | undefined;

const answer = (path: string, input: Input) => {
  const ids = input.imageIds ?? [];
  switch (path) {
    case 'placement.getStickerPlacementCounts':
      return counts(ids);
    case 'placement.getStickerPlacementsAndCounts':
      return bundle(ids);
    case 'placement.getRemixGalleryCardSummaries':
      return remix(ids);
    case 'placement.getImageCardSummaries':
      return {
        stickers:
          input.stickers === 'placements'
            ? bundle(ids)
            : input.stickers === 'counts'
            ? { counts: counts(ids) }
            : undefined,
        remix: input.remix ? remix(ids) : undefined,
      };
    default:
      return [];
  }
};

function stubFetch() {
  requests.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (resource: RequestInfo | URL) => {
      const url = new URL(
        typeof resource === 'string' ? resource : resource.toString(),
        'http://test'
      );
      const path = url.pathname.replace('/api/trpc/', '');
      const raw = url.searchParams.get('input');
      const input: Input = raw ? JSON.parse(raw).json ?? {} : {};
      const request = { path, input };
      if (path.startsWith('placement.')) requests.push(request);
      await hold?.(request);
      return new Response(JSON.stringify({ result: { data: { json: answer(path, input) } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
}

type Seen = { count: number; placementIds: number[]; remixCount: number | undefined };
const seen = new Map<number, Seen>();
let forget: ((placementId: number) => Promise<void>) | undefined;

function Card({ imageId }: { imageId: number }) {
  const batch = useStickerPlacementBatch(imageId);
  const summary = useRemixGalleryBatch(imageId);
  seen.set(imageId, {
    count: batch?.count ?? -1,
    placementIds: batch?.placements.map((placement) => placement.id) ?? [],
    remixCount: summary?.count,
  });
  return null;
}

function Forgetter() {
  forget = useForgetStickerPlacement();
  return null;
}

const Provider = ImagesProvider as unknown as ComponentType<{ images: unknown }>;

function Surface() {
  return createElement(
    Provider,
    { images: IMAGES },
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

async function renderSurface({ fold }: { fold: boolean }) {
  act(() => root?.unmount());
  queryClient.clear();
  seen.clear();
  requests.length = 0;
  flags.current = {
    stickers: true,
    stickerPlacement: true,
    remixGallery: true,
    placementCardFold: fold,
  };
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

const snapshot = () => new Map(seen);

beforeEach(() => {
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

describe('a signed-in feed surface', () => {
  it('flag off: one sticker call and one remix call per 100 cards, as before', async () => {
    session.user = { id: 7 };
    await renderSurface({ fold: false });

    expect(byPath()).toEqual({
      'placement.getStickerPlacementsAndCounts': 2,
      'placement.getRemixGalleryCardSummaries': 2,
    });
  });

  it('flag on: ONE call per 100 cards carries both, and every card reads the same values', async () => {
    session.user = { id: 7 };
    await renderSurface({ fold: false });
    const unfolded = snapshot();
    expect(unfolded.get(1042)).toEqual({
      count: countOf(1042),
      placementIds: [placementOf(1042).id],
      remixCount: remixCountOf(1042),
    });

    await renderSurface({ fold: true });

    expect(byPath()).toEqual({ 'placement.getImageCardSummaries': 2 });
    expect(requests.map((request) => request.input.stickers)).toEqual(['placements', 'placements']);
    expect(requests.flatMap((request) => request.input.imageIds ?? []).sort()).toEqual(
      [...IDS].sort()
    );
    expect(snapshot()).toEqual(unfolded);
  });
});

describe('an anonymous feed surface with stickers hidden', () => {
  it('flag on: one call per 100 cards, counts and remix only, same values as off', async () => {
    await renderSurface({ fold: false });
    expect(byPath()).toEqual({
      'placement.getStickerPlacementCounts': 2,
      'placement.getRemixGalleryCardSummaries': 2,
    });
    const unfolded = snapshot();

    await renderSurface({ fold: true });

    expect(byPath()).toEqual({ 'placement.getImageCardSummaries': 2 });
    expect(requests.map((request) => request.input.stickers)).toEqual(['counts', 'counts']);
    expect(snapshot()).toEqual(unfolded);
    expect(seen.get(1100)).toEqual({
      count: countOf(1100),
      placementIds: [],
      remixCount: remixCountOf(1100),
    });
  });

  it('flag on: keeps the count and the remix frames on screen while a reveal is in flight', async () => {
    await renderSurface({ fold: true });

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    hold = (request) =>
      request.path === 'placement.getImageCardSummaries' && request.input.stickers === 'placements'
        ? gate
        : undefined;

    await act(async () => {
      useStickerRevealStore.setState({ revealed: true });
    });
    await settle();

    expect(
      requests.filter((request) => request.input.stickers === 'placements').map((r) => r.path)
    ).toEqual(['placement.getImageCardSummaries', 'placement.getImageCardSummaries']);
    expect(seen.get(1042)).toEqual({
      count: countOf(1042),
      placementIds: [],
      remixCount: remixCountOf(1042),
    });

    release();
    await settle();
    expect(seen.get(1042)).toEqual({
      count: countOf(1042),
      placementIds: [placementOf(1042).id],
      remixCount: remixCountOf(1042),
    });
  });
});

describe('removing a placement with the flag on', () => {
  it('drops it, and one from its count, on the card that held it and no other', async () => {
    session.user = { id: 7 };
    await renderSurface({ fold: true });
    const callsBefore = requests.length;

    await act(async () => {
      await forget?.(placementOf(1120).id);
    });
    await settle();

    expect(seen.get(1120)).toEqual({
      count: countOf(1120) - 1,
      placementIds: [],
      remixCount: remixCountOf(1120),
    });
    expect(seen.get(1121)).toEqual({
      count: countOf(1121),
      placementIds: [placementOf(1121).id],
      remixCount: remixCountOf(1121),
    });
    expect(seen.get(1010)?.placementIds).toEqual([placementOf(1010).id]);
    expect(
      requests
        .slice(callsBefore)
        .filter((request) => request.path !== 'placement.getStickerPlacementDetail')
    ).toEqual([]);
  });
});
