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

import { IMAGES_CARD_FOOTER_HEIGHT, ImagesCard } from '~/components/Image/Infinite/ImagesCard';
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
      const duration = [...rating_.parentElement!.children].find((el) =>
        /^\d+:\d\d$/.test(el.textContent ?? '')
      ) as HTMLElement;
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

// The masonry sizes a card as image + IMAGES_CARD_FOOTER_HEIGHT, so a taller footer takes its
// excess from the bottom of the picture. Columns are 320px; a phone's single column is its width.
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
            <ImagesCard data={reacted} height={400} />
          </div>
        </IntersectionObserverProvider>
      </TurfSummaryContext.Provider>
    );
    await vi.waitFor(() =>
      expect(document.body.querySelectorAll('[aria-label$="reaction"]').length).toBeGreaterThan(3)
    );
    if (value) await vi.waitFor(() => expect(q('hat-turf-gear')).not.toBeNull());
    expect(footerHeight()).toBe(IMAGES_CARD_FOOTER_HEIGHT);
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
  async function renderCrowded(width: number) {
    features.stickerPlacement = true;
    stickerBadge.renders = true;
    renderWithProviders(
      <TurfSummaryContext.Provider value={turf()}>
        <IntersectionObserverProvider>
          <div style={{ width }}>
            <ImagesCard data={crowded} height={400} />
          </div>
        </IntersectionObserverProvider>
      </TurfSummaryContext.Provider>
    );
    await vi.waitFor(() => expect(q('hat-turf-gear')).not.toBeNull());
    await vi.waitFor(() =>
      expect(document.body.querySelector('[aria-label*="sticker" i]')).not.toBeNull()
    );
  }
  // How many reactions fit depends on the fonts; a reaction that doesn't wraps onto a line the
  // bar clips, where it can be neither seen, hit nor focused.
  function reactionState() {
    const bar = document.body.querySelector('[class*="fitReactions"]')!.getBoundingClientRect();
    return [...document.body.querySelectorAll<HTMLElement>('[aria-label$="reaction"]')].map(
      (el) => {
        const r = el.getBoundingClientRect();
        const inert = el.inert;
        // Hit-testing skips an inert element, so it is lifted while the point is sampled: what is
        // measured is whether the bar's clipping hides it. Its top edge lies inside the footer's
        // padding, above where the card itself clips.
        el.inert = false;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 2);
        el.inert = inert;
        return {
          dropped: r.top >= bar.bottom - 0.5,
          whole: r.bottom <= bar.bottom + 0.5 && r.right <= bar.right + 0.5,
          visible: !!hit && el.contains(hit),
          inert,
        };
      }
    );
  }

  test.each([288, 320, 358])(
    'a %ipx card with three-digit counts, a tip, a sticker chip and the hat button',
    async (width) => {
      await renderCrowded(width);
      expect(footerHeight()).toBe(IMAGES_CARD_FOOTER_HEIGHT);
      const reactions = reactionState();
      // At 288px some reaction always drops, so the checks below have something to check.
      if (width === 288) expect(reactions.some((r) => r.dropped)).toBe(true);
      await vi.waitFor(() => {
        for (const r of reactionState()) {
          if (r.dropped) expect(r).toMatchObject({ visible: false, inert: true });
          else expect(r).toMatchObject({ whole: true, visible: true, inert: false });
        }
      });
    }
  );

  test('a card wide enough for everything drops no reaction', async () => {
    await renderCrowded(600);
    expect(footerHeight()).toBe(IMAGES_CARD_FOOTER_HEIGHT);
    const reactions = reactionState();
    expect(reactions).toHaveLength(4);
    for (const r of reactions)
      expect(r).toMatchObject({ dropped: false, whole: true, visible: true, inert: false });
  });
});
