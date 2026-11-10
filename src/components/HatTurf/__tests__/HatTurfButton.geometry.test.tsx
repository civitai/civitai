import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as CardStickerOverlayModule from '~/components/Sticker/CardStickerOverlay';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsModule from '~/providers/BrowserSettingsProvider';
import type * as TrackUtilsModule from '~/components/TrackView/track.utils';
import type * as ImageContextMenuModule from '~/components/Image/ContextMenu/ImageContextMenu';
import type * as CardRemixButtonModule from '~/components/Image/Remix/CardRemixButton';

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
// The header's buttons are real only where a test measures them (the +N chip below).
const header = { real: false };
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', async (importOriginal) => {
  const real = await importOriginal<typeof ImageContextMenuModule>();
  return {
    ...real,
    ImageContextMenu: (props: Parameters<typeof real.ImageContextMenu>[0]) =>
      header.real ? <real.ImageContextMenu {...props} /> : null,
  };
});
vi.mock('~/components/Image/Remix/CardRemixButton', async (importOriginal) => {
  const real = await importOriginal<typeof CardRemixButtonModule>();
  return {
    CardRemixButton: (props: Parameters<typeof real.CardRemixButton>[0]) =>
      header.real ? <real.CardRemixButton {...props} /> : null,
  };
});
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

type TurfSummaries = NonNullable<React.ContextType<typeof TurfSummaryContext>>['images'];
type TurfStickers = NonNullable<React.ContextType<typeof TurfSummaryContext>>['stickers'];

async function renderCard(
  viewport: { width: number; height: number } = PHONE_VIEWPORT,
  {
    width = 171,
    images = {},
    stickers = {},
  }: { width?: number; images?: TurfSummaries; stickers?: TurfStickers } = {}
) {
  useHatTurfStore.setState({ cosmeticId: null, showHats: true });
  await renderAtViewport(
    <TurfSummaryContext.Provider
      value={{
        event: 'birthday2026',
        arm: 'control',
        team: 'blue',
        images,
        open: {},
        stickers,
        joined: true,
        watch: () => () => undefined,
      }}
    >
      <IntersectionObserverProvider>
        <div style={{ width }} data-testid="card-frame">
          <ImageCard data={image} />
        </div>
      </IntersectionObserverProvider>
    </TurfSummaryContext.Provider>,
    viewport
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

  // Seen on a phone: "Show hats" sat at the row's left and its switch at the far right, too small
  // to hit. The switch comes first and its label right after it, and on a phone the switch is
  // bigger in a tap row taller than it. A 44px row in the panel's 12px pad then read as too much
  // padding around one switch, so the space above and below the switch is bounded too.
  test.each([
    ['phone', PHONE_VIEWPORT],
    ['desktop', { width: 1280, height: 800 }],
  ] as const)(
    'Show hats in the panel: switch first, its label beside it (%s)',
    async (name, vp) => {
      await renderCard(vp);
      (document.body.querySelector('[data-testid="hat-turf-gear"]') as HTMLElement).click();
      await vi.waitFor(() =>
        expect(document.body.querySelector('[data-testid="hat-turf-show-hats"]')).not.toBeNull()
      );
      // The phone panel is a sheet that slides up: measure it at rest.
      await new Promise((r) => setTimeout(r, 600));
      await nextLayout();
      // The test id lands on the switch's input; measure from its root.
      const root = document.body
        .querySelector('[data-testid="hat-turf-show-hats"]')!
        .closest('.mantine-Switch-root')!;
      const track = root.querySelector('.mantine-Switch-track')!.getBoundingClientRect();
      const label = root.querySelector('.mantine-Switch-label')!;
      const text = document.createRange();
      text.selectNodeContents(label);
      const words = text.getBoundingClientRect();
      expect(track.right).toBeLessThanOrEqual(words.left);
      expect(words.left - track.right).toBeLessThan(16);
      const body = root.querySelector('.mantine-Switch-body')!.getBoundingClientRect();
      if (name === 'phone') {
        expect(body.height).toBeGreaterThanOrEqual(32);
        expect(track.height).toBeGreaterThanOrEqual(24);
        // From the divider above the row to the switch, and from the switch to the sheet's edge.
        const pad = root.parentElement!.getBoundingClientRect();
        expect({ above: track.top - pad.top, below: pad.bottom - track.bottom }).toEqual({
          above: expect.toSatisfy((px: number) => px <= 14),
          below: expect.toSatisfy((px: number) => px <= 14),
        });
        // The whole row takes the tap: a press near its bottom edge, under the label, flips it.
        const hit = document.elementFromPoint(words.left + 4, body.bottom - 2) as HTMLElement;
        expect(hit.closest('label')).not.toBeNull();
        hit.click();
        await vi.waitFor(() => expect(useHatTurfStore.getState().showHats).toBe(false));
      } else {
        expect(track.height).toBeLessThan(24);
      }
    }
  );
});

// Feedback: the "+N" hats chip sat at the card's top right, under the Remix button the card's
// header stacks below its menu, so it could not be seen.
describe('the +N hats chip on a feed card', () => {
  const overlaps = (a: DOMRect, b: DOMRect) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  test.each([171, 260, 320])('clears the Remix and menu buttons at %spx', async (width) => {
    features.imageGeneration = true;
    header.real = true;
    try {
      await renderCard(
        { width: 1280, height: 800 },
        {
          width,
          images: {
            [image.id]: {
              shown: { blue: 6, pink: 4 },
              counted: { blue: 6, pink: 4 },
              leader: 'blue',
              leaderCosmeticId: 11,
              hatted: true,
              hattedTeam: null,
            },
          },
          stickers: {
            [image.id]: [1, 2].map((id) => ({
              id,
              userId: 10 + id,
              team: 'blue',
              cosmeticId: 11,
              data: { x: 0.3 * id, y: 0.6, scale: 0.2, rotation: 0, flip: false },
            })),
          },
        }
      );
      const q = (selector: string) => document.body.querySelector(selector);
      await vi.waitFor(() => expect(q('[data-testid="hat-turf-more"]')).not.toBeNull());
      const chip = q('[data-testid="hat-turf-more"]')!.getBoundingClientRect();
      expect(chip.width).toBeGreaterThan(0);
      const remix = q('[data-activity="remix:image-card-home"]')!;
      expect(remix.getBoundingClientRect().width).toBeGreaterThan(0);
      // The header's right column: the menu button with Remix under it.
      const column = remix.closest('.flex-col')!.getBoundingClientRect();
      expect(column.height).toBeGreaterThan(remix.getBoundingClientRect().height);
      expect(overlaps(chip, column), 'the +N chip is under the menu or Remix button').toBe(false);
      // It moves to the left, under the badge row there.
      const badge = q('[data-testid="hat-turf-count"]')!.getBoundingClientRect();
      expect(badge.width).toBeGreaterThan(0);
      expect(overlaps(chip, badge), 'the +N chip is under the Hat Turf badge').toBe(false);
      const frame = q('[data-testid="card-frame"]')!.getBoundingClientRect();
      expect(chip.left).toBeGreaterThanOrEqual(frame.left);
      expect(chip.right).toBeLessThanOrEqual(frame.right);
    } finally {
      features.imageGeneration = false;
      header.real = false;
    }
  });
});
