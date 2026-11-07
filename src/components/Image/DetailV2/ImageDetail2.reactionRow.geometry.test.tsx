import type { ReactNode } from 'react';
import { DEFAULT_THEME, MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import type * as TrpcModule from '~/utils/trpc';
import type * as ImageDetailProviderModule from '~/components/Image/Detail/ImageDetailProvider';
import type * as HatTurfDetailProviderModule from '~/components/HatTurf/detail/HatTurfDetailProvider';

import '~/styles/globals.css';

// Layout test: the REAL reaction pills in the real footer row, beside a fixed-width sticker bar.
const ctx = vi.hoisted(() => ({ active: false, hats: true, hideReactions: false }));
const image = {
  id: 1,
  url: 'img-1',
  nsfwLevel: 1,
  width: 700,
  height: 900,
  type: 'image',
  name: null,
  postId: 5,
  poi: false,
  minor: false,
  hasMeta: false,
  tagIds: [],
  publishedAt: new Date('2026-11-01'),
  user: { id: 2, username: 'someone' },
  // The counts from the report (/images/147311969): three-digit counts are what clipped.
  stats: {
    likeCountAllTime: 775,
    heartCountAllTime: 276,
    laughCountAllTime: 68,
    cryCountAllTime: 21,
    tippedAmountCountAllTime: 120,
  },
  reactions: [{ userId: 2, reaction: 'Heart' }],
};

// A button around its child, as the real one is (an UnstyledButton), with its other props.
vi.mock('~/components/Buzz/InteractiveTipBuzzButton', () => ({
  InteractiveTipBuzzButton: ({
    children,
    toUserId: _u,
    entityId: _i,
    entityType: _t,
    ...rest
  }: {
    children: ReactNode;
    toUserId: number;
    entityId: number;
    entityType: string;
  }) => (
    <button type="button" style={{ display: 'flex' }} {...rest}>
      {children}
    </button>
  ),
  useBuzzTippingStore: () => 0,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy(
    {
      'hatTurf.getStock': {
        useQuery: () => ({
          data: { available: 3, optedIn: true, mode: 'live', cap: 50, nextAt: null },
        }),
      },
      'hatTurf.getImageStickers': {
        useQuery: () => ({ data: { stickers: [], mine: null, nextCursor: null } }),
      },
      'hatTurf.getMyStickerHats': {
        useQuery: () => ({ data: [{ cosmeticId: 11, usageCount: 3, lastUsedAt: null }] }),
      },
      'event.getMyHats': {
        useQuery: () => ({ data: [{ cosmeticId: 11, name: 'Party Cap' }] }),
      },
    },
    { useUtils: () => ({ hatTurf: { getStock: { invalidate: async () => undefined } } }) }
  ),
}));
vi.mock('~/components/Image/Detail/ImageDetailProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageDetailProviderModule>()),
  useImageDetailContext: () => ({
    images: [image],
    index: 0,
    active: ctx.active,
    close: () => undefined,
    toggleInfo: () => undefined,
    shareUrl: '/images/1',
    navigate: () => undefined,
    loadMore: () => undefined,
    hasMore: false,
    collection: undefined,
    hideReactions: ctx.hideReactions,
  }),
}));
vi.mock('~/components/HatTurf/detail/HatTurfDetailProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof HatTurfDetailProviderModule>()),
  takesHats: () => ctx.hats,
  HatTurfDetailProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  HatTurfDetailReset: () => null,
}));
vi.mock('~/hooks/useCurrentUser', async (o) => ({
  ...(await o<object>()),
  useCurrentUser: () => ({ id: 2, isModerator: false, muted: false, filePreferences: {} }),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (o) => ({
  ...(await o<object>()),
  useFeatureFlags: () => ({ hatTurfImageDetail: true }),
}));
vi.mock('~/providers/BrowserSettingsProvider', async (o) => ({
  ...(await o<object>()),
  useBrowsingSettings: <T,>(select: (state: Record<string, unknown>) => T) =>
    select({ browsingLevel: 1, blurNsfw: true, showNsfw: false, autoplayGifs: false }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (o) => ({
  ...(await o<object>()),
  BrowsingLevelProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', async (o) => ({
  ...(await o<object>()),
  BrowsingSettingsAddonsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
const stub = vi.hoisted(() => () => null);
vi.mock('~/components/Storyline/StorylineDetail', async (o) => ({
  ...(await o<object>()),
  StorylineStageOverlay: stub,
  StorylineToolbarChip: stub,
}));
vi.mock('~/components/Storyline/StorylineChapterRail', async (o) => ({
  ...(await o<object>()),
  StorylineChapterRail: stub,
}));
vi.mock('~/components/Ads/AdhesiveAd', async (o) => ({
  ...(await o<object>()),
  AdhesiveAd: stub,
}));
vi.mock('~/components/Ads/AdUnit', async (o) => ({
  ...(await o<object>()),
  AdUnitSide_2: stub,
  AdUnitSide_3: stub,
}));
vi.mock('~/components/Ads/AdUnitOutstream', async (o) => ({
  ...(await o<object>()),
  AdUnitOutstream: stub,
}));
vi.mock('~/components/Carousel/CarouselIndicators', async (o) => ({
  ...(await o<object>()),
  CarouselIndicators: stub,
}));
vi.mock('~/components/Image/DetailV2/OwnerBlockedImageNotice', async (o) => ({
  ...(await o<object>()),
  OwnerBlockedImageNotice: stub,
}));
vi.mock('~/components/EntityCollaborator/EntityCollaboratorList', async (o) => ({
  ...(await o<object>()),
  EntityCollaboratorList: stub,
}));
vi.mock('~/components/Model3D/Posting/PostingToModel3DCard', async (o) => ({
  ...(await o<object>()),
  PostingToModel3DCard: stub,
}));
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', async (o) => ({
  ...(await o<object>()),
  ImageContextMenu: stub,
}));
vi.mock('~/components/Image/DetailV2/ImageExternalMeta', async (o) => ({
  ...(await o<object>()),
  ImageExternalMeta: stub,
}));
vi.mock('~/components/Image/DetailV2/ImageGenerationData', async (o) => ({
  ...(await o<object>()),
  ImageGenerationData: stub,
}));
vi.mock('~/components/Image/DetailV2/ImagePublishedWithApp', async (o) => ({
  ...(await o<object>()),
  ImagePublishedWithApp: stub,
}));
vi.mock('~/components/RemixGallery/RemixGalleryCard', async (o) => ({
  ...(await o<object>()),
  RemixGalleryCard: stub,
}));
vi.mock('~/components/Image/DetailV2/ImageProcess', async (o) => ({
  ...(await o<object>()),
  ImageProcess: stub,
}));
vi.mock('~/components/Image/Remix/RemixMenu', async (o) => ({
  ...(await o<object>()),
  isRemixMenuVisible: () => true,
  RemixMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('~/components/Image/DetailV2/ImageRemixOfDetails', async (o) => ({
  ...(await o<object>()),
  ImageRemixOfDetails: stub,
}));
vi.mock('~/components/Image/DownloadImage', async (o) => ({
  ...(await o<object>()),
  DownloadImage: stub,
}));
vi.mock('~/components/Metrics', async (o) => ({
  ...(await o<object>()),
  Metrics: ({ initial, children }: { initial: unknown; children: (m: unknown) => ReactNode }) =>
    children(initial),
}));
// The viewer owns the image on a touch screen: the real preview adds its "Who reacted" button to
// the row, which makes it the narrowest case.
vi.mock('~/components/UserAvatar/UserHoverCard', async (o) => ({
  ...(await o<object>()),
  useHoverCapable: () => false,
}));
vi.mock('~/components/ShareButton/ShareButton', async (o) => ({
  ...(await o<object>()),
  ShareButton: stub,
}));
vi.mock('~/components/VotableTags/VotableTags', async (o) => ({
  ...(await o<object>()),
  VotableTags: stub,
}));
vi.mock('~/components/LoginRedirect/LoginRedirect', async (o) => ({
  ...(await o<object>()),
  LoginRedirect: stub,
}));
vi.mock('~/components/Gated/Gated', () => ({
  Gated: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('~/components/ImageGuard/ImageGuard2', async (o) => {
  function ImageGuard2({ children }: { children: (safe: boolean) => ReactNode }) {
    return <>{children(true)}</>;
  }
  ImageGuard2.BlurToggle = function BlurToggle({ className }: { className?: string }) {
    return (
      <span data-testid="rating-pill" className={className} style={{ width: 36, height: 36 }} />
    );
  };
  return { ...(await o<object>()), ImageGuard2 };
});
vi.mock('~/components/Image/DetailV2/ImageDetailCarousel', () => ({
  ImageDetailCarousel: () => <div style={{ flex: 1 }} />,
}));
vi.mock('~/components/Image/DetailV2/ImageContestCollectionDetails', async (o) => ({
  ...(await o<object>()),
  useImageContestCollectionDetails: () => ({ collectionItems: [], post: undefined }),
  ImageContestCollectionDetails: () => null,
}));
vi.mock('~/components/TrackView/TrackView', () => ({ TrackView: () => null }));
// About the width of the signed-in bar ("1 sticker", history, +) in the reported screenshot.
vi.mock('~/components/Sticker/StickerPlacementBar', () => ({
  StickerPlacementBar: () => (
    <div data-testid="sticker-bar" style={{ width: 124, height: 30, flexShrink: 0 }} />
  ),
}));
vi.mock('~/components/CreatorCard/CreatorCard', async (o) => ({
  ...(await o<object>()),
  SmartCreatorCard: () => null,
}));
vi.mock('~/components/Image/Detail/ImageDetailComments', () => ({
  ImageDetailComments: () => null,
}));

import { HatTurfCardProvider } from '~/components/HatTurf/HatTurfCardProvider';
import { TurfSummaryContext } from '~/components/HatTurf/TurfSummaryProvider';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { ImageDetail2 } from '~/components/Image/DetailV2/ImageDetail2';
import { renderAtViewport } from '../../../../test/geometry-setup';

async function renderDetail(width: number) {
  const PHONE = { width, height: 844 };
  await renderAtViewport(
    // The app theme adds an `accent` palette the tip badge reads.
    <MantineProvider theme={{ colors: { accent: DEFAULT_THEME.colors.orange } }}>
      <div style={PHONE}>
        <TurfSummaryContext.Provider
          value={{
            event: 'birthday2026',
            arm: null,
            team: 'blue',
            images: {},
            open: { 1: true },
            stickers: {},
            joined: true,
            watch: () => () => undefined,
          }}
        >
          <HatTurfCardProvider>
            <ContainerProvider containerName="main">
              <ImageDetail2 />
            </ContainerProvider>
          </HatTurfCardProvider>
        </TurfSummaryContext.Provider>
      </div>
    </MantineProvider>,
    PHONE
  );
}

const q = (id: string) =>
  document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const label = (name: string) =>
  document.body.querySelector(`[aria-label="${name}"]`) as HTMLElement | null;
// The desktop toolbar is in the DOM too, hidden: take the copy that is drawn.
const drawn = (els: Iterable<Element>) =>
  Array.from(els).find((el) => el.getBoundingClientRect().width > 0) as HTMLElement | undefined;

afterEach(() => {
  cleanup();
  ctx.hats = true;
  ctx.hideReactions = false;
});

/** Each digit of every count in the reaction row, against the label that clips it. */
function countDigits() {
  const row = label('Like reaction')!.parentElement!;
  return Array.from(row.querySelectorAll<HTMLElement>('[data-testid="cnf-digit"]')).map((d) => {
    const clip = d.closest('.mantine-Button-label, .mantine-Badge-label')!.getBoundingClientRect();
    const r = d.getBoundingClientRect();
    return { digit: d.dataset.digit, cutRight: r.right - clip.right, cutLeft: clip.left - r.left };
  });
}

const leftToRight = (els: (HTMLElement | null | undefined)[]) =>
  els.map((el) => Math.round(el!.getBoundingClientRect().left));
const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]);
/** Vertical centre of each, rounded: items in one bar share it. */
const middles = (els: (HTMLElement | null | undefined)[]) =>
  new Set(
    els.map((el) => {
      const r = el!.getBoundingClientRect();
      return Math.round(r.top + r.height / 2);
    })
  );

describe.each([360, 390])('image detail on a %ipx phone', (width) => {
  test('every reaction count is whole, with three-digit counts', async () => {
    await renderDetail(width);
    await vi.waitFor(() => expect(label('Like reaction')).not.toBeNull());
    expect(label('Who reacted')).not.toBeNull();
    const digits = countDigits();
    // 775 / 276 / 68 / 21 and the 120 Buzz chip: 13 digits, so the check cannot pass empty.
    expect(digits).toHaveLength(13);
    expect(digits.filter((d) => d.cutRight > 0.5 || d.cutLeft > 0.5)).toEqual([]);
  });

  test('the reaction row is the reactions and Buzz chip alone, on one line', async () => {
    await renderDetail(width);
    await vi.waitFor(() => expect(label('Like reaction')).not.toBeNull());
    const row = label('Like reaction')!.parentElement!;
    // The footer under the picture, not just the reactions' own box.
    expect(row.closest('.flex-col')!.contains(q('sticker-bar'))).toBe(false);
    const tops = new Set(
      Array.from(row.children).map((el) => Math.round(el.getBoundingClientRect().top))
    );
    expect(tops.size).toBe(1);
  });

  test('top bar: close, hat score badge, rating pill, from the left', async () => {
    await renderDetail(width);
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    const close = q('image-detail-close');
    const badge = drawn(document.querySelectorAll('[data-testid="hat-turf-detail-badge"]'));
    const pill = drawn(document.querySelectorAll('[data-testid="rating-pill"]'));
    const xs = leftToRight([close, badge, pill]);
    expect(ascending(xs)).toBe(true);
    // Beside Close, not pushed to the right edge.
    expect(xs[2]).toBeLessThan(width / 2);
  });

  test('bottom bar: Remix, Save, hat, sticker pill, then the chevron', async () => {
    await renderDetail(width);
    await vi.waitFor(() => expect(q('hat-turf-detail-hat')).not.toBeNull());
    const bar = [
      drawn(document.querySelectorAll('[aria-label="Remix"]')),
      drawn(document.querySelectorAll('[aria-label="Save"]')),
      q('hat-turf-detail-hat'),
      q('sticker-bar'),
      q('image-detail-chevron'),
    ];
    expect(ascending(leftToRight(bar))).toBe(true);
    expect(middles(bar).size).toBe(1);
    expect(q('image-detail-chevron')!.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    // Icon-only circles the size of the hat button.
    for (const el of bar.slice(0, 3)) {
      const r = el!.getBoundingClientRect();
      expect([r.width, r.height]).toEqual([36, 36]);
    }
    // The Tip button is gone: the Buzz chip in the reaction row tips.
    expect(drawn(document.querySelectorAll('[data-testid="image-detail-tip"]'))).toBeUndefined();
  });

  test('the hat sheet spans the screen', async () => {
    await renderDetail(width);
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    q('hat-turf-detail-badge')!.click();
    await vi.waitFor(() => expect(q('hat-turf-panel')).not.toBeNull());
    const sheet = q('hat-turf-panel')!.closest<HTMLElement>('.mantine-Drawer-content')!;
    await vi.waitFor(() => expect(Math.round(sheet.getBoundingClientRect().width)).toBe(width));
  });

  // The Buzz chip goes with the reactions, so the bar keeps a way to tip.
  test('with reactions hidden, the bottom bar has a Tip circle', async () => {
    ctx.hideReactions = true;
    await renderDetail(width);
    await vi.waitFor(() => expect(q('hat-turf-detail-hat')).not.toBeNull());
    expect(label('Like reaction')).toBeNull();
    const tip = drawn(document.querySelectorAll('[data-testid="image-detail-tip"]'));
    expect(tip?.tagName).toBe('BUTTON');
    expect(tip!.getAttribute('aria-label')).toBe('Tip');
    // One button: the tip wrapper is it, and what it wraps is not another.
    expect(tip!.querySelector('button')).toBeNull();
    const r = tip!.getBoundingClientRect();
    expect([r.width, r.height]).toEqual([36, 36]);
    const chevron = q('image-detail-chevron')!.getBoundingClientRect();
    expect(r.right).toBeLessThanOrEqual(chevron.left);
    expect(chevron.right).toBeLessThanOrEqual(width);
  });

  test('with Hat Turf off, both bars keep their order without the badge or hat', async () => {
    ctx.hats = false;
    await renderDetail(width);
    await vi.waitFor(() => expect(q('sticker-bar')).not.toBeNull());
    expect(q('hat-turf-detail-badge')).toBeNull();
    expect(q('hat-turf-detail-hat')).toBeNull();
    const pill = drawn(document.querySelectorAll('[data-testid="rating-pill"]'));
    expect(ascending(leftToRight([q('image-detail-close'), pill]))).toBe(true);
    const bar = [
      drawn(document.querySelectorAll('[aria-label="Remix"]')),
      drawn(document.querySelectorAll('[aria-label="Save"]')),
      q('sticker-bar'),
      q('image-detail-chevron'),
    ];
    expect(ascending(leftToRight(bar))).toBe(true);
    expect(middles(bar).size).toBe(1);
  });
});

// Where each control renders is decided in JS (`narrowStage`) and where the phone bar shows in CSS
// (`@md:hidden`). Between phone and desktop the two must agree, or a control renders hidden.
const allDrawn = (selector: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.getBoundingClientRect().width > 0
  );
const tipControls = () => [
  ...allDrawn('[data-testid="image-detail-tip"]'),
  // The Buzz chip: the reaction row's one button without a label of its own.
  ...allDrawn('button').filter(
    (b) =>
      !b.hasAttribute('aria-label') && b.parentElement === label('Like reaction')?.parentElement
  ),
];

describe.each([480, 600, 768, 900, 1023, 1024, 1100])('image detail at %ipx', (width) => {
  test('the sticker pill, the hat button and a tip control are each drawn once', async () => {
    await renderDetail(width);
    await vi.waitFor(() => expect(label('Like reaction')).not.toBeNull());
    expect(allDrawn('[data-testid="sticker-bar"]')).toHaveLength(1);
    expect(allDrawn('[data-testid="hat-turf-detail-hat"]')).toHaveLength(1);
    expect(tipControls().length).toBeGreaterThanOrEqual(1);
  });

  test('with reactions hidden, a tip control is still drawn', async () => {
    ctx.hideReactions = true;
    await renderDetail(width);
    await vi.waitFor(() => expect(allDrawn('[data-testid="sticker-bar"]')).toHaveLength(1));
    expect(tipControls().length).toBeGreaterThanOrEqual(1);
  });
});
