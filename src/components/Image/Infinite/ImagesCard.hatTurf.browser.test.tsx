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
const rating = vi.hoisted(() => ({ renders: false }));
vi.mock('~/components/ImageGuard/ImageGuard2', () => {
  function ImageGuard2({ children }: { children: (safe: boolean) => ReactNode }) {
    return <>{children(true)}</>;
  }
  // A stand-in for the rating chip that keeps the size the card asks for; off unless a test turns it on.
  ImageGuard2.BlurToggle = function BlurToggle({ h }: { h?: number }) {
    return rating.renders ? (
      <span data-testid="rating-badge" style={{ display: 'inline-flex', height: h, width: 30 }}>
        PG
      </span>
    ) : null;
  };
  return { ImageGuard2 };
});
vi.mock('~/components/LoginPopover/LoginPopover', () => ({
  LoginPopover: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
// The real chip, so the footer measures its real width; only its batch query is skipped.
vi.mock('~/components/Sticker/StickerPlacementCardBadge', async () => {
  const { StickerCountChip } = await import('~/components/Sticker/StickerCountChip');
  return {
    StickerPlacementCardBadge: () =>
      stickerBadge.renders ? (
        <StickerCountChip count={1} revealed onClick={() => undefined} />
      ) : null,
  };
});
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
import {
  adjustImagesCardHeight,
  getImagesCardFooterHeight,
  getImagesCardHeight,
  IMAGES_CARD_FOOTER_ONE_ROW_HEIGHT,
  IMAGES_CARD_ONE_ROW_MIN_WIDTH,
} from '~/components/Image/Infinite/images-card-footer';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { TurfSummaryContext } from '~/components/HatTurf/TurfSummaryProvider';
import type { TurfSummaries } from '~/components/HatTurf/TurfSummaryProvider';
import { renderWithProviders, LOADABLE_IMAGE_DATA_URI } from '../../../../test/component-setup';
import { cleanup } from 'vitest-browser-react';
import { CollectionMode, MediaType } from '~/shared/utils/prisma/enums';
import { collectionHidesHatTurf } from '~/components/HatTurf/hat-turf.utils';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';

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

const stickerOnCard = {
  id: 501,
  userId: 9,
  team: 'blue',
  data: { x: 0.5, y: 0.4, scale: 0.18, rotation: 0, flip: false },
};

/** The /images card, under the feed's turf context (null: Hat Turf is off for the viewer). */
function renderCard(value: TurfSummaries | null, data = image, width = 300) {
  renderWithProviders(
    <TurfSummaryContext.Provider value={value}>
      <IntersectionObserverProvider>
        <div style={{ width }}>
          <ImagesCard data={data} height={400} />
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
  useHatTurfStore.setState({ showHats: true });
  stickerBadge.renders = false;
  rating.renders = false;
  features.stickerPlacement = false;
});

describe('Hat Turf on the /images feed card', () => {
  // 171: a 2-up grid on a 390px phone; 320: a desktop column.
  test.each([
    [171, 'with', turf],
    [320, 'with', turf],
    [171, 'without', () => null],
    [320, 'without', () => null],
  ])(
    'a %ipx video card %s a turf badge keeps its corner chips on one 24px line',
    async (width, _, value) => {
      rating.renders = true;
      const video = { ...image, type: MediaType.video, metadata: { duration: 95 } };
      renderCard(value(), video, width);
      await vi.waitFor(() => expect(q('rating-badge')).not.toBeNull());
      const rating_ = q('rating-badge')!;
      const duration = q('duration-badge')!;
      expect(duration.textContent).toBe('1m 35s');
      expect(duration.parentElement).toBe(rating_.parentElement);
      const chips = [q('hat-turf-badge'), rating_, duration].filter(Boolean) as HTMLElement[];
      expect(chips.length).toBe(value() ? 3 : 2);
      const boxes = chips.map((el) => el.getBoundingClientRect());
      for (const box of boxes) {
        expect(box.height).toBe(24);
        expect(box.top).toBe(boxes[0].top);
      }
      // Left to right: turf badge, rating, length.
      for (let i = 1; i < boxes.length; i++)
        expect(boxes[i].left).toBeGreaterThanOrEqual(boxes[i - 1].right);
    }
  );

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

  // The joined test above is the positive control: same card, same context, showHats on.
  test('with Show hats off a joined player keeps the badge, hat button and gear, but sees no hats', async () => {
    useHatTurfStore.setState({ showHats: false });
    renderCard({ ...turf(), stickers: { 77: [stickerOnCard] as never } });
    await vi.waitFor(() => expect(q('hat-turf-gear')).not.toBeNull());
    expect(q('hat-turf-badge')).not.toBeNull();
    expect(q('hat-turf-button')).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(q('hat-turf-hat')).toBeNull();
  });

  test('a joined player with Show hats on sees the hats placed on the card', async () => {
    renderCard({ ...turf(), stickers: { 77: [stickerOnCard] as never } });
    await vi.waitFor(() => expect(q('hat-turf-hat')).not.toBeNull());
  });

  // My live hats is served on this card, not on ImageCard: the chip once shipped on the wrong one.
  test("My live hats: the card shows how long the viewer's hat has left", async () => {
    h.stock = {
      ...h.stock,
      expiry: { ttlHours: 48, rolloutAt: null },
    } as typeof h.stock;
    renderCard(turf(), { ...image, turfPlacedAt: new Date(Date.now() - 6 * 3_600_000) });
    await vi.waitFor(() => expect(q('hat-turf-time-left')?.textContent).toBe('42h left'));
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

// /search/images sizes its cards with no footer reservation, which holds only while hideReactions
// keeps the footer off the card. The feed row is the control that the footer does draw here.
test.each([
  ['a feed', false],
  ['search (hideReactions)', true],
])('under ImagesProvider, %s draws the reaction footer: %s → hidden', async (_, hideReactions) => {
  renderWithProviders(
    <ImagesProvider images={[image]} hideReactions={hideReactions}>
      <IntersectionObserverProvider>
        <div style={{ width: 300 }}>
          <ImagesCard data={image} height={400} />
        </div>
      </IntersectionObserverProvider>
    </ImagesProvider>
  );
  await vi.waitFor(() => expect(q('hat-turf-layer')).not.toBeNull());
  const footer = () => document.body.querySelector('[class*="actionsFooter"]');
  if (!hideReactions) return void (await vi.waitFor(() => expect(footer()).not.toBeNull()));
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(footer()).toBeNull();
});

// The masonry sizes a card as image + getImagesCardFooterHeight(width), so a taller footer takes
// its excess from the bottom of the picture. Columns are 320px; a phone's single column is its width.
describe('the /images card footer fits the height the masonry gives it', () => {
  const reacted = {
    ...image,
    stats: {
      likeCountAllTime: 35,
      heartCountAllTime: 22,
      laughCountAllTime: 14,
      cryCountAllTime: 4,
      tippedAmountCountAllTime: 30,
    },
  };
  const footerHeight = () =>
    document.body.querySelector<HTMLElement>('[class*="actionsFooter"]')!.getBoundingClientRect()
      .height;

  test.each([
    [288, 'with the hat button', turf()],
    [320, 'with the hat button', turf()],
    [358, 'with the hat button', turf()],
    [320, 'without Hat Turf', null],
  ])('a %ipx card with four reaction counts and a tip, %s', async (width, _, value) => {
    renderWithProviders(
      <TurfSummaryContext.Provider value={value}>
        <IntersectionObserverProvider>
          <div style={{ width }}>
            <ImagesCard data={reacted} height={400} width={width} />
          </div>
        </IntersectionObserverProvider>
      </TurfSummaryContext.Provider>
    );
    await vi.waitFor(() =>
      expect(document.body.querySelectorAll('[aria-label$="reaction"]').length).toBeGreaterThan(3)
    );
    if (value) await vi.waitFor(() => expect(q('hat-turf-gear')).not.toBeNull());
    expect(footerHeight()).toBe(getImagesCardFooterHeight(width));
  });
  // A tester's card: three-digit counts, a 530 tip and a sticker chip beside the hat button.
  const crowded = {
    ...image,
    stats: {
      likeCountAllTime: 179,
      heartCountAllTime: 72,
      laughCountAllTime: 24,
      cryCountAllTime: 12,
      tippedAmountCountAllTime: 530,
    },
  };
  // The longest counts the abbreviation produces, and a tip to match.
  const longest = {
    ...crowded,
    stats: {
      likeCountAllTime: 12345,
      heartCountAllTime: 9876,
      laughCountAllTime: 666,
      cryCountAllTime: 258,
      tippedAmountCountAllTime: 12345,
    },
  };
  async function renderCrowded(width: number, height = 400, data = crowded) {
    features.stickerPlacement = true;
    stickerBadge.renders = true;
    renderWithProviders(
      <TurfSummaryContext.Provider value={turf()}>
        <IntersectionObserverProvider>
          <div style={{ width }}>
            <ImagesCard data={data} height={height} width={width} />
          </div>
        </IntersectionObserverProvider>
      </TurfSummaryContext.Provider>
    );
    await vi.waitFor(() => expect(q('hat-turf-gear')).not.toBeNull());
    await vi.waitFor(() =>
      expect(document.body.querySelector('[aria-label*="sticker" i]')).not.toBeNull()
    );
  }
  // Every reaction must be whole inside the footer, on one line, and reachable by a tap.
  function reactionState() {
    const footer = document.body.querySelector('[class*="actionsFooter"]')!.getBoundingClientRect();
    return [...document.body.querySelectorAll<HTMLElement>('[aria-label$="reaction"]')].map(
      (el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          top: r.top,
          whole:
            r.left >= footer.left - 0.5 &&
            r.right <= footer.right + 0.5 &&
            r.bottom <= footer.bottom + 0.5,
          visible: !!hit && el.contains(hit),
        };
      }
    );
  }
  function expectAllFourShown() {
    const reactions = reactionState();
    expect(reactions).toHaveLength(4);
    for (const r of reactions) expect(r).toMatchObject({ whole: true, visible: true });
    // One line of reactions: a wrapped one would push the tip row out of the reserved height.
    expect(new Set(reactions.map((r) => Math.round(r.top))).size).toBe(1);
  }

  // A tester reported the Cry reaction missing on feed images. Every non-zero reaction stays
  // seen and tappable at every width, with the footer exactly the height the masonry reserves.
  // The widths straddle IMAGES_CARD_ONE_ROW_MIN_WIDTH, where the footer changes from two rows to one.
  test.each([
    240,
    288,
    320,
    358,
    IMAGES_CARD_ONE_ROW_MIN_WIDTH - 1,
    IMAGES_CARD_ONE_ROW_MIN_WIDTH,
    600,
  ])('a %ipx card shows all four reactions in the height the masonry reserves', async (width) => {
    await renderCrowded(width);
    await vi.waitFor(() => expect(footerHeight()).toBe(getImagesCardFooterHeight(width)));
    await vi.waitFor(expectAllFourShown);
  });

  // A third line of reactions would grow the footer past the reserved height and crop the picture.
  // Not asserted at 240px, where five-character counts do wrap: the masonry's columns are 320px,
  // and a phone's single column is its width, so no real card is that narrow.
  test.each([288, 358, IMAGES_CARD_ONE_ROW_MIN_WIDTH - 1])(
    'a %ipx card with the longest counts keeps its reserved height',
    async (width) => {
      await renderCrowded(width, 400, longest);
      await vi.waitFor(() => expect(footerHeight()).toBe(getImagesCardFooterHeight(width)));
      expectAllFourShown();
    }
  );

  test('the masonry reserves what the card draws', () => {
    expect(adjustImagesCardHeight({ height: 300, width: 288 })).toBe(
      300 + getImagesCardFooterHeight(288)
    );
    expect(adjustImagesCardHeight({ height: 300, width: 600 })).toBe(
      300 + IMAGES_CARD_FOOTER_ONE_ROW_HEIGHT
    );
    // A custom card draws no such footer.
    expect(adjustImagesCardHeight({ height: 300, width: 288 }, true)).toBe(
      300 + IMAGES_CARD_FOOTER_ONE_ROW_HEIGHT
    );
  });

  test('below the threshold the tip row sits under the reactions', async () => {
    await renderCrowded(IMAGES_CARD_ONE_ROW_MIN_WIDTH - 1);
    const tip = document.body.querySelector('[class*="tipRow"]')!.getBoundingClientRect();
    const first = document.body.querySelector('[aria-label$="reaction"]')!.getBoundingClientRect();
    expect(tip.top).toBeGreaterThanOrEqual(first.bottom - 0.5);
  });

  test('at the threshold the tip shares the reactions row', async () => {
    await renderCrowded(IMAGES_CARD_ONE_ROW_MIN_WIDTH);
    const tip = document.body.querySelector('[class*="tipRow"]')!.getBoundingClientRect();
    const first = document.body.querySelector('[aria-label$="reaction"]')!.getBoundingClientRect();
    expect(tip.top).toBeLessThan(first.bottom);
  });

  // The hat button stays inside the footer and tappable in both layouts, at 360 and below.
  test.each([240, 288, 360, IMAGES_CARD_ONE_ROW_MIN_WIDTH - 1, IMAGES_CARD_ONE_ROW_MIN_WIDTH])(
    'a %ipx card keeps the hat button reachable',
    async (width) => {
      await renderCrowded(width);
      const footer = document.body
        .querySelector('[class*="actionsFooter"]')!
        .getBoundingClientRect();
      const gear = q('hat-turf-gear')!.closest('button')!;
      const r = gear.getBoundingClientRect();
      expect(r.width).toBeGreaterThan(0);
      expect(r.left).toBeGreaterThanOrEqual(footer.left - 0.5);
      expect(r.right).toBeLessThanOrEqual(footer.right + 0.5);
      expect(r.bottom).toBeLessThanOrEqual(footer.bottom + 0.5);
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      expect(gear.contains(hit)).toBe(true);
    }
  );

  // The crop testers reported twice (fixed in #7816): a footer taller than the masonry reserved
  // took its excess from the picture. The picture must keep the height the masonry computed.
  const pictureHeight = () =>
    document.body
      .querySelector('[class*="actionsFooter"]')!
      .previousElementSibling!.getBoundingClientRect().height;
  const PICTURE = 300;
  // The card's own 1px border above and below; the same at every width, one row or two.
  const BORDER = 2;

  test.each([240, 288, 320, 358, IMAGES_CARD_ONE_ROW_MIN_WIDTH - 1, IMAGES_CARD_ONE_ROW_MIN_WIDTH])(
    'a %ipx card keeps the picture at the height the masonry computed',
    async (width) => {
      await renderCrowded(width, getImagesCardHeight(PICTURE, width));
      await vi.waitFor(() => expect(footerHeight()).toBe(getImagesCardFooterHeight(width)));
      expect(pictureHeight()).toBe(PICTURE - BORDER);
    }
  );

  // Control: reserve the old one-row height for a two-row footer and the picture is cropped, so
  // the assertion above can fail.
  test('a two-row footer in a one-row reservation crops the picture', async () => {
    await renderCrowded(288, PICTURE + IMAGES_CARD_FOOTER_ONE_ROW_HEIGHT);
    await vi.waitFor(() => expect(footerHeight()).toBe(getImagesCardFooterHeight(288)));
    expect(pictureHeight()).toBeLessThan(PICTURE - BORDER);
  });
});
