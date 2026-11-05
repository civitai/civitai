import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as CardStickerOverlayModule from '~/components/Sticker/CardStickerOverlay';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsModule from '~/providers/BrowserSettingsProvider';
import type * as TrackUtilsModule from '~/components/TrackView/track.utils';

const features = {
  stickerPlacement: false,
  imageCardInfoButton: false,
  imageGeneration: false,
  hatTurfFeedCard: true,
};
// The real badge renders null for an image with no stickers; the tip-row tests flip this.
const stickerBadge = { renders: true };

// Both provider mocks spread the real module. The card's import graph reaches other exports of
// each (`useOptionalFeatureFlags` via the impression hook, `useAutoplayGifs` via the nameplate),
// and a hand-listed mock that omits one fails the whole file at import, collecting 0 tests.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => features,
}));
const h = vi.hoisted(() => ({
  stock: { available: 3, optedIn: true } as { available: number; optedIn: boolean } | undefined,
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
vi.mock('~/components/Image/Providers/ImagesProvider', () => ({
  useImagesContext: () => ({ getImages: () => [] }),
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

import { ImageCard } from '~/components/Cards/ImageCard';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { TurfSummaryContext } from '~/components/HatTurf/TurfSummaryProvider';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { MediaType } from '~/shared/utils/prisma/enums';
import {
  LOADABLE_IMAGE_DATA_URI,
  PHONE_VIEWPORT,
  nextLayout,
  renderAtViewport,
} from '../../../../test/geometry-setup';

/**
 * The feed card's hat button sits in the tip row beside the reaction chips. Measured against the
 * real cascade: a taller button grows the row, and the gear glyph has to sit in the middle of its
 * round chip to read as a gear at 16px.
 */

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
  user: { id: 2, username: 'someone' },
  stats: { likeCountAllTime: 1082, heartCountAllTime: 12400, tippedAmountCountAllTime: 25000 },
} as unknown as Parameters<typeof ImageCard>[0]['data'];

async function renderCard() {
  useHatTurfStore.setState({ cosmeticId: null, showHats: true });
  await renderAtViewport(
    <TurfSummaryContext.Provider
      value={{
        event: 'birthday2026',
        arm: 'control',
        team: 'blue',
        images: {},
        open: {},
        stickers: {},
        joined: true,
        watch: () => () => undefined,
      }}
    >
      <IntersectionObserverProvider>
        <div style={{ width: 171 }}>
          <ImageCard data={image} />
        </div>
      </IntersectionObserverProvider>
    </TurfSummaryContext.Provider>,
    PHONE_VIEWPORT
  );
  await vi.waitFor(() =>
    expect(document.body.querySelector('[data-testid="hat-turf-gear"] svg')).not.toBeNull()
  );
}

const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

describe('Hat Turf button geometry on a feed card', () => {
  test('the hat button is as tall as the reaction chips beside it', async () => {
    await renderCard();
    const hat = document.body.querySelector(
      '[data-testid="hat-turf-button"] button[aria-pressed]'
    )!;
    const reaction = document.body.querySelector('[aria-label$="reaction"]')!;
    const reactionHeight = reaction.getBoundingClientRect().height;
    expect(reactionHeight).toBeGreaterThan(0);
    expect(hat.getBoundingClientRect().height).toBe(reactionHeight);
  });

  // Layout only: device-pixel snapping at a fractional devicePixelRatio never reaches
  // getBoundingClientRect, so this cannot see the drift reported at 1.275.
  test.each([1, 1.275, 1.5])(
    'the gear glyph is centred in its round chip at zoom %s',
    async (z) => {
      await renderCard();
      document.documentElement.style.zoom = String(z);
      try {
        await nextLayout();
        const chip = document.body.querySelector('[data-testid="hat-turf-gear"]')!;
        // The drawn gear, not the svg's box: a glyph can sit off-centre inside a centred viewBox.
        const ink = chip.querySelector('svg path:not([stroke="none"][fill="none"])')!;
        const c = centre(chip.getBoundingClientRect());
        const g = centre(ink.getBoundingClientRect());
        expect(Math.abs(g.x - c.x) * z).toBeLessThanOrEqual(0.5);
        expect(Math.abs(g.y - c.y) * z).toBeLessThanOrEqual(0.5);
      } finally {
        document.documentElement.style.zoom = '';
      }
    }
  );
});
