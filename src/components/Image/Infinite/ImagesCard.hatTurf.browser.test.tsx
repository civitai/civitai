import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as CardStickerOverlayModule from '~/components/Sticker/CardStickerOverlay';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsModule from '~/providers/BrowserSettingsProvider';
import type * as TrackUtilsModule from '~/components/TrackView/track.utils';

import '~/styles/globals.css';

const features = {
  stickerPlacement: false,
  imageCardInfoButton: false,
  imageGeneration: false,
  hatTurfFeedCard: true,
};
const stickerBadge = { renders: false };

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => features,
}));
const h = vi.hoisted(() => ({
  stock: { available: 3, optedIn: true },
  mutate: vi.fn(),
  optIn: vi.fn(),
  invalidate: vi.fn(async () => undefined),
  user: { id: 1 } as { id: number } | null,
  trackAction: vi.fn<(data: unknown) => Promise<void>>(async () => undefined),
}));
vi.mock('~/components/TrackView/track.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof TrackUtilsModule>()),
  useTrackEvent: () => ({ trackAction: h.trackAction }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy(
      {
        'hatTurf.getStock': { useQuery: () => ({ data: h.stock, isLoading: false }) },
        'hatTurf.getMyStickerHats': {
          useQuery: () => ({
            data: [
              { cosmeticId: 11, usageCount: 3, lastUsedAt: null },
              { cosmeticId: 12, usageCount: 0, lastUsedAt: null },
            ],
          }),
        },
        'event.getMyHats': {
          useQuery: () => ({
            data: [
              { cosmeticId: 11, name: 'Party Cap' },
              { cosmeticId: 12, name: 'Top Hat' },
            ],
          }),
        },
        'hatTurf.place': { useMutation: () => ({ isPending: false, mutate: h.mutate }) },
        'hatTurf.setOptIn': { useMutation: () => ({ isPending: false, mutate: h.optIn }) },
      },
      {
        useUtils: () => ({
          hatTurf: {
            getStock: { invalidate: h.invalidate },
            getSummaries: { invalidate: h.invalidate },
            getStickersForImages: { invalidate: h.invalidate },
          },
        }),
      }
    ),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () =>
    h.user ? { ...h.user, isModerator: false, muted: false, filePreferences: {} } : null,
}));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsModule>()),
  useBrowsingSettings: <T,>(selector: (state: { autoplayGifs: boolean }) => T) =>
    selector({ autoplayGifs: false }),
}));
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', () => ({
  ImageContextMenu: () => null,
}));
vi.mock('~/components/Image/Remix/CardRemixButton', () => ({ CardRemixButton: () => null }));
vi.mock('~/components/UserAvatar/UserAvatarSimple', () => ({
  UserAvatarSimple: () => <span>user</span>,
}));
vi.mock('~/components/ImageGuard/ImageGuard2', () => {
  function ImageGuard2({ children }: { children: (safe: boolean) => ReactNode }) {
    return <>{children(true)}</>;
  }
  ImageGuard2.BlurToggle = function BlurToggle() {
    return null;
  };
  return { ImageGuard2 };
});
vi.mock('~/components/LoginPopover/LoginPopover', () => ({
  LoginPopover: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('~/components/Sticker/StickerPlacementCardBadge', () => ({
  StickerPlacementCardBadge: () =>
    stickerBadge.renders ? (
      <button data-testid="sticker-badge" style={{ height: 26 }}>
        stickers
      </button>
    ) : null,
}));
vi.mock('~/components/Sticker/CardStickerOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof CardStickerOverlayModule>()),
  CardStickerOverlay: () => null,
}));
vi.mock('~/components/Buzz/InteractiveTipBuzzButton', () => ({
  InteractiveTipBuzzButton: ({ children }: { children: ReactNode }) => <>{children}</>,
  useBuzzTippingStore: () => 0,
}));

vi.mock('~/components/Signals/SignalsProvider', () => ({
  useSignalTopic: () => undefined,
  useSignalConnection: () => undefined,
}));

vi.mock('~/components/HatTurf/useHatTurfFeed', () => ({
  useHatTurfFeed: () => ({ event: 'birthday2026', arm: 'control' }),
}));
vi.mock('~/components/Storyline/StorylineBatchProvider', async (o) => ({
  ...(await o<object>()),
  useStorylineForPost: () => undefined,
}));
vi.mock('~/components/Tours/ToursProvider', async (o) => ({
  ...(await o<object>()),
  useTourContext: () => ({ running: false, helpers: undefined }),
}));

import { ImagesCard } from '~/components/Image/Infinite/ImagesCard';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { TurfSummaryContext } from '~/components/HatTurf/TurfSummaryProvider';
import type { TurfSummaries } from '~/components/HatTurf/TurfSummaryProvider';
import { renderWithProviders, LOADABLE_IMAGE_DATA_URI } from '../../../../test/component-setup';
import { cleanup } from 'vitest-browser-react';
import { CollectionMode, MediaType } from '~/shared/utils/prisma/enums';
import { collectionHidesHatTurf } from '~/components/HatTurf/hat-turf.utils';

const image = {
  id: 77,
  url: LOADABLE_IMAGE_DATA_URI,
  type: MediaType.image,
  name: 'card.png',
  metadata: null,
  nsfwLevel: 1,
  width: 700,
  height: 900,
  hasMeta: false,
  poi: false,
  reactions: [],
  ingestion: 'Scanned',
  publishedAt: new Date('2026-11-01'),
  user: { id: 2, username: 'someone' },
  stats: { likeCountAllTime: 3, heartCountAllTime: 4 },
} as any;

const turf = (): TurfSummaries => ({
  event: 'birthday2026',
  arm: 'control',
  team: 'blue',
  images: {
    77: {
      shown: { blue: 2 },
      counted: { blue: 2 },
      leader: 'blue',
      leaderCosmeticId: 11,
      hatted: false,
      hattedTeam: null,
    },
  },
  open: { 77: true },
  stickers: {},
  joined: h.stock.optedIn,
  watch: () => () => undefined,
});

/** The /images card, under the feed's turf context (null: Hat Turf is off for the viewer). */
function renderCard(value: TurfSummaries | null) {
  renderWithProviders(
    <TurfSummaryContext.Provider value={value}>
      <IntersectionObserverProvider>
        <div style={{ width: 300 }}>
          <ImagesCard data={image} height={400} />
        </div>
      </IntersectionObserverProvider>
    </TurfSummaryContext.Provider>
  );
}

const q = (id: string) =>
  document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const cardRendered = () =>
  vi.waitFor(() => expect(document.body.querySelector('[aria-label$="reaction"]')).not.toBeNull());

afterEach(() => {
  cleanup();
  h.stock = { available: 3, optedIn: true };
});

describe('Hat Turf on the /images feed card', () => {
  test('a joined player on a flagged feed gets the hat button, the standings badge and the hat layer', async () => {
    renderCard(turf());
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    expect(q('hat-turf-gear')).not.toBeNull();
    expect(q('hat-turf-badge')).not.toBeNull();
    expect(q('hat-turf-layer')).not.toBeNull();
  });

  // Turf is seen by joined players only; a viewer who has not joined keeps the hat button as the
  // way in. The joined test above is the positive control for the badge and the layer.
  test('a viewer who has not joined gets the hat button but no standings badge or hat layer', async () => {
    h.stock = { available: 3, optedIn: false };
    renderCard(turf());
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    expect(q('hat-turf-badge')).toBeNull();
    expect(q('hat-turf-layer')).toBeNull();
  });

  test('with Hat Turf off for the viewer the card has none of it', async () => {
    renderCard(null);
    await cardRendered();
    expect(q('hat-turf-button')).toBeNull();
    expect(q('hat-turf-badge')).toBeNull();
  });

  test.each([
    ['a feed', false, true],
    ['the sticker book (hideHatTurf)', true, false],
    ['a bookmark collection', collectionHidesHatTurf({ mode: CollectionMode.Bookmark }), true],
    ['a contest collection', collectionHidesHatTurf({ mode: CollectionMode.Contest }), false],
  ])('under ImagesProvider, %s shows Hat Turf: %s → %s', async (_, hideHatTurf, shown) => {
    renderWithProviders(
      <ImagesProvider images={[image]} hideHatTurf={hideHatTurf}>
        <IntersectionObserverProvider>
          <div style={{ width: 300 }}>
            <ImagesCard data={image} height={400} />
          </div>
        </IntersectionObserverProvider>
      </ImagesProvider>
    );
    await cardRendered();
    if (shown) await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    else {
      // The feed case shows the button inside this window, so absence here is a real absence.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(q('hat-turf-button')).toBeNull();
    }
  });
});
