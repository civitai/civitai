// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { act, createElement, Fragment } from 'react';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { RemixGalleryCard } from '~/components/RemixGallery/RemixGalleryCard';
import { detailStickerMode } from '~/components/Sticker/card-summaries.util';
import {
  resolveStickerCounts,
  useStickerPlacementCounts,
  useStickerPlacements,
} from '~/components/Sticker/placement.util';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import { useStickerRevealStore } from '~/store/sticker-reveal.store';
import { queryClient, trpc } from '~/utils/trpc';

/**
 * 🔴 HOW MANY PLACEMENT CALLS THE IMAGE DETAIL VIEW MAKES for the image it shows, with and without
 * `placementCardFold`, counted on the wire (only `fetch` is stubbed).
 *
 * The view asks about one image from three places: the sticker bar, the sticker overlay and the
 * remix card. Off, that is a sticker call plus a remix-summary call. On, the three build one
 * input and share ONE call — which holds only while their inputs match, so this renders the real
 * remix card beside the bar's and the overlay's hooks and counts what leaves.
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
  useBrowsingLevelContext: () => ({ blurLevels: 4 }),
}));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: unknown }) => children,
}));
vi.mock('~/components/RemixGallery/SparkStorylineTile', () => ({
  SparkStorylineTile: () => null,
}));

const HOST = 74;
const STICKER_COUNT = 9;
const PLACEMENT_ID = 4431;
const STORY_COUNT = 3;

const visibility = {
  open: true,
  hasEntries: false,
  render: true,
  price: 100,
  ownerId: 41,
  ownerUsername: 'owner',
  ownerShare: 0.7,
  freeSlots: 0,
  freeSlotsRemaining: null,
  declineFee: 30,
  pendingCount: 0,
  viewerPending: [],
  maxSubmissionLevel: null,
  acceptedMaxLevel: null,
};
const placement = {
  id: PLACEMENT_ID,
  imageId: HOST,
  placerId: 52,
  ownerId: 41,
  status: 'approved',
  amount: 700,
  free: false,
  data: { cosmeticId: 85, x: 0.5, y: 0.5, scale: 0.2, rotation: 0 },
  placedAt: '2026-10-01T00:00:00.000Z',
  isPending: false,
  hasComment: false,
};
const story = (storylineId: number) => ({
  storylineId,
  title: `Story ${storylineId}`,
  username: `writer${storylineId}`,
  previews: [],
});
const counts = { [HOST]: STICKER_COUNT };
const bundle = { placements: [placement], counts };
const summaries = {
  [HOST]: {
    count: 0,
    entries: [],
    storylines: { count: STORY_COUNT, entries: [story(1), story(2), story(3)] },
  },
};

type Input = { stickers?: string; remix?: boolean };
const requests: { path: string; input: Input }[] = [];

const answer = (path: string, input: Input) => {
  switch (path) {
    case 'placement.getRemixGalleryVisibility':
      return visibility;
    case 'placement.getStickerPlacementsAndCounts':
      return bundle;
    case 'placement.getStickerPlacementCounts':
      return counts;
    case 'placement.getRemixGalleryCardSummaries':
      return summaries;
    case 'placement.getImageCardSummaries':
      return {
        stickers:
          input.stickers === 'placements'
            ? bundle
            : input.stickers === 'counts'
            ? { counts }
            : undefined,
        remix: input.remix ? summaries : undefined,
      };
    default:
      return null;
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
      if (path.startsWith('placement.')) requests.push({ path, input });
      return new Response(JSON.stringify({ result: { data: { json: answer(path, input) } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
}

const shown = { count: -1, placementIds: [] as number[] };

/** The sticker bar's two hooks, wired as the bar wires them. */
function BarHooks() {
  const wantPlacements =
    detailStickerMode({ signedIn: !!session.user, revealed: false }) === 'placements';
  const placements = useStickerPlacements([HOST], wantPlacements);
  const countsOnly = useStickerPlacementCounts([HOST], !wantPlacements);
  const { counts: resolved } = resolveStickerCounts({
    wantPlacements,
    combined: {
      data: placements.counts,
      isLoading: placements.isLoading,
      isError: placements.isError,
    },
    countsOnly,
  });
  shown.count = resolved[HOST] ?? 0;
  return null;
}

/** The sticker overlay's hook, enabled as the overlay enables it. */
function OverlayHooks() {
  const { byImage } = useStickerPlacements([HOST], !!session.user);
  shown.placementIds = (byImage.get(HOST) ?? []).map((row) => row.id);
  return null;
}

let root: Root | undefined;
let container: HTMLElement;

async function renderDetail({ fold }: { fold: boolean }) {
  act(() => root?.unmount());
  queryClient.clear();
  requests.length = 0;
  shown.count = -1;
  shown.placementIds = [];
  flags.current = {
    stickers: true,
    stickerPlacement: true,
    remixGallery: true,
    storylines: true,
    placementCardFold: fold,
  };
  const Inner = () =>
    createElement(
      MantineProvider,
      null,
      createElement(
        Fragment,
        null,
        createElement(BarHooks),
        createElement(OverlayHooks),
        createElement(RemixGalleryCard, { imageId: HOST })
      )
    );
  const Wrapped = trpc.withTRPC(Inner as never) as unknown as ComponentType<{ pageProps: object }>;
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Wrapped, { pageProps: {} }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

const byPath = () =>
  requests.reduce<Record<string, number>>((tally, request) => {
    tally[request.path] = (tally[request.path] ?? 0) + 1;
    return tally;
  }, {});

beforeEach(() => {
  session.user = null;
  useStickerRevealStore.setState({ revealed: false, forced: 0, forcedDismissed: false });
  stubFetch();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the image detail view, signed in', () => {
  it('flag off: a sticker call and a remix-summary call, as before', async () => {
    session.user = { id: 7 };
    await renderDetail({ fold: false });

    expect(byPath()).toEqual({
      'placement.getRemixGalleryVisibility': 1,
      'placement.getStickerPlacementsAndCounts': 1,
      'placement.getRemixGalleryCardSummaries': 1,
    });
    expect(shown).toEqual({ count: STICKER_COUNT, placementIds: [PLACEMENT_ID] });
    expect(container.textContent).toContain(`${STORY_COUNT} stories started here`);
  });

  it('flag on: the bar, the overlay and the remix card share ONE call, and show the same', async () => {
    session.user = { id: 7 };
    await renderDetail({ fold: true });

    expect(byPath()).toEqual({
      'placement.getRemixGalleryVisibility': 1,
      'placement.getImageCardSummaries': 1,
    });
    expect(shown).toEqual({ count: STICKER_COUNT, placementIds: [PLACEMENT_ID] });
    expect(container.textContent).toContain(`${STORY_COUNT} stories started here`);
  });
});

describe('the image detail view, signed out with stickers hidden', () => {
  it('flag off: a count call and a remix-summary call, as before', async () => {
    await renderDetail({ fold: false });

    expect(byPath()).toEqual({
      'placement.getRemixGalleryVisibility': 1,
      'placement.getStickerPlacementCounts': 1,
      'placement.getRemixGalleryCardSummaries': 1,
    });
    expect(shown).toEqual({ count: STICKER_COUNT, placementIds: [] });
  });

  it('flag on: the bar and the remix card share ONE counts call', async () => {
    await renderDetail({ fold: true });

    expect(byPath()).toEqual({
      'placement.getRemixGalleryVisibility': 1,
      'placement.getImageCardSummaries': 1,
    });
    expect(requests.find((r) => r.path === 'placement.getImageCardSummaries')?.input).toMatchObject(
      { stickers: 'counts', remix: true }
    );
    expect(shown).toEqual({ count: STICKER_COUNT, placementIds: [] });
    expect(container.textContent).toContain(`${STORY_COUNT} stories started here`);
  });
});
