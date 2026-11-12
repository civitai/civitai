import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as CardStickerOverlayModule from '~/components/Sticker/CardStickerOverlay';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsModule from '~/providers/BrowserSettingsProvider';
import type * as TrackUtilsModule from '~/components/TrackView/track.utils';

// The /images card's "+N" hats chip, measured against the real cascade. It once sat under the
// Remix button in the right-hand column; on feed cards it now sits on the left, under the row of
// chips there (badge, rating, time left), so it must clear both.

const features = {
  stickerPlacement: false,
  imageCardInfoButton: false,
  imageGeneration: true,
  hatTurfFeedCard: true,
};

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => features,
}));
vi.mock('~/components/TrackView/track.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof TrackUtilsModule>()),
  useTrackEvent: () => ({ trackAction: async () => undefined }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  const invalidate = async () => undefined;
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy(
      {
        // An expiry, so the time-left chip renders for an item with turfPlacedAt.
        'hatTurf.getStock': {
          useQuery: () => ({
            data: { available: 3, optedIn: true, expiry: { ttlHours: 48, rolloutAt: null } },
            isLoading: false,
          }),
        },
        'hatTurf.getMyStickerHats': { useQuery: () => ({ data: [] }) },
        'event.getMyHats': { useQuery: () => ({ data: [] }) },
        'hatTurf.place': { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
        'hatTurf.setOptIn': { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      },
      {
        useUtils: () => ({
          hatTurf: {
            getStock: { invalidate },
            getSummaries: { invalidate },
            getStickersForImages: { invalidate },
            getImageStickers: { invalidate },
          },
        }),
      }
    ),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, isModerator: false, muted: false, filePreferences: {} }),
}));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsModule>()),
  useBrowsingSettings: <T,>(selector: (state: { autoplayGifs: boolean }) => T) =>
    selector({ autoplayGifs: false }),
}));
vi.mock('~/components/UserAvatar/UserAvatarSimple', () => ({
  UserAvatarSimple: () => <span>user</span>,
}));
vi.mock('~/components/ImageGuard/ImageGuard2', () => {
  function ImageGuard2({ children }: { children: (safe: boolean) => ReactNode }) {
    return <>{children(true)}</>;
  }
  // A stand-in for the rating chip at the size the card asks for, so the left row is full.
  ImageGuard2.BlurToggle = function BlurToggle({ h }: { h?: number }) {
    return (
      <span data-testid="rating-badge" style={{ display: 'inline-flex', height: h, width: 30 }}>
        PG
      </span>
    );
  };
  return { ImageGuard2 };
});
vi.mock('~/components/LoginPopover/LoginPopover', () => ({
  LoginPopover: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('~/components/Sticker/StickerPlacementCardBadge', () => ({
  StickerPlacementCardBadge: () => null,
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
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { TurfSummaryContext } from '~/components/HatTurf/TurfSummaryProvider';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { MediaType } from '~/shared/utils/prisma/enums';
import { LOADABLE_IMAGE_DATA_URI, renderAtViewport } from '../../../../test/geometry-setup';

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
  // My live hats: the time-left chip joins the left row.
  turfPlacedAt: new Date(Date.now() - 6 * 3_600_000),
} as unknown as Parameters<typeof ImagesCard>[0]['data'];

const overlaps = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const q = (selector: string) => document.body.querySelector(selector) as HTMLElement | null;

describe('the +N hats chip on the /images card', () => {
  test.each([171, 260, 320])(
    'clears the left row and the menu and Remix column at %spx',
    async (width) => {
      useHatTurfStore.setState({ cosmeticId: null, showHats: true });
      await renderAtViewport(
        <TurfSummaryContext.Provider
          value={{
            event: 'birthday2026',
            arm: 'control',
            team: 'blue',
            images: {
              77: {
                shown: { blue: 6, pink: 4 },
                counted: { blue: 6, pink: 4 },
                leader: 'blue',
                leaderCosmeticId: 11,
                hatted: true,
                hattedTeam: null,
              },
            },
            open: { 77: true },
            stickers: {
              77: [1, 2].map((id) => ({
                id,
                userId: 10 + id,
                team: 'blue',
                cosmeticId: 11,
                data: { x: 0.3 * id, y: 0.6, scale: 0.2, rotation: 0, flip: false },
              })),
            },
            joined: true,
            watch: () => () => undefined,
          }}
        >
          <IntersectionObserverProvider>
            <div style={{ width }} data-testid="card-frame">
              <ImagesCard data={image} height={400} />
            </div>
          </IntersectionObserverProvider>
        </TurfSummaryContext.Provider>,
        { width: 1280, height: 800 }
      );
      await vi.waitFor(() => expect(q('[data-testid="hat-turf-more"]')).not.toBeNull());
      const chip = q('[data-testid="hat-turf-more"]')!.getBoundingClientRect();
      expect(chip.width).toBeGreaterThan(0);

      // The left row: every chip in it, whichever of them render.
      const row = [...q('[data-testid="hat-turf-badge"]')!.parentElement!.children];
      expect(row.some((el) => el.matches('[data-testid="rating-badge"]'))).toBe(true);
      for (const el of row) {
        const r = el.getBoundingClientRect();
        expect(r.width).toBeGreaterThan(0);
        const name = el.getAttribute('data-testid') ?? el.className;
        expect(overlaps(chip, r), `the +N chip is under ${name}`).toBe(false);
      }

      // The right column: the menu button with Remix under it.
      const remix = q('[data-activity="remix:image-card"]')!;
      const column = remix.closest('.flex-col')!.getBoundingClientRect();
      expect(column.height).toBeGreaterThan(remix.getBoundingClientRect().height);
      expect(overlaps(chip, column), 'the +N chip is under the menu or Remix button').toBe(false);

      const frame = q('[data-testid="card-frame"]')!.getBoundingClientRect();
      expect(chip.left).toBeGreaterThanOrEqual(frame.left);
      expect(chip.right).toBeLessThanOrEqual(frame.right);
    }
  );
});
