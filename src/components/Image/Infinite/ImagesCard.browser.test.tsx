import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type * as RoutedDialogLinkModule from '~/components/Dialog/RoutedDialogLink';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import '~/styles/globals.css';
import '@mantine/core/styles.layer.css';

const features = { stickerPlacement: true, imageCardInfoButton: false, imageGeneration: false };

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => features,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof Trpc>()), trpc: makeTrpcProxy() };
});
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, isModerator: false, muted: false, filePreferences: {} }),
}));
vi.mock('~/components/Image/Providers/ImagesProvider', () => ({
  useImagesContext: () => ({ getImages: () => [] }),
}));
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', () => ({
  ImageContextMenu: () => null,
}));
vi.mock('~/components/Image/Remix/RemixMenu', () => ({
  RemixMenu: () => null,
  isRemixMenuVisible: () => false,
}));
vi.mock('~/components/RemixGallery/use-remix-card-data', () => ({
  useRemixCardData: () => ({ any: false }),
}));
vi.mock('~/components/RemixGallery/RemixedCardFlyout', () => ({ RemixedCardFlyout: () => null }));
vi.mock('~/components/Tours/ToursProvider', () => ({
  useTourContext: () => ({ running: false, helpers: null }),
}));
vi.mock('~/components/Storyline/StorylineBatchProvider', () => ({
  useStorylineForPost: () => undefined,
}));
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<typeof RoutedDialogLinkModule>()),
  RoutedDialogLink: ({ children }: { children: ReactNode }) => <>{children}</>,
  triggerRoutedDialog: () => undefined,
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  EdgeMedia2: () => (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: 'linear-gradient(135deg,#3b5bdb,#9c36b5)',
      }}
    />
  ),
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
vi.mock('~/components/Sticker/StickerPlacementBatchProvider', () => ({
  useStickerPlacementBatch: () => ({ count: 1, pending: [] }),
}));
vi.mock('~/components/Metrics/useMetricSubscription', () => ({
  useMetricSubscription: () => undefined,
}));
vi.mock('~/components/Sticker/CardStickerOverlay', () => ({ CardStickerOverlay: () => null }));
vi.mock('~/components/Buzz/InteractiveTipBuzzButton', () => ({
  InteractiveTipBuzzButton: ({ children }: { children: ReactNode }) => <>{children}</>,
  useBuzzTippingStore: () => 0,
}));

import { ImagesCard } from './ImagesCard';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { renderWithProviders } from '../../../../test/component-setup';
import { MediaType } from '~/shared/utils/prisma/enums';

function imageData(s: Record<string, number>) {
  return {
    id: 1,
    url: 'x',
    type: MediaType.image,
    name: 'card.png',
    metadata: null,
    nsfwLevel: 1,
    width: 700,
    height: 900,
    hasMeta: false,
    poi: false,
    publishedAt: new Date('2026-01-01'),
    reactions: [],
    user: { id: 2, username: 'someone' },
    stats: {
      likeCountAllTime: s.like,
      dislikeCountAllTime: 0,
      heartCountAllTime: s.heart,
      laughCountAllTime: s.laugh,
      cryCountAllTime: s.cry,
      tippedAmountCountAllTime: s.tip,
    },
  } as any;
}

// Reported 2026-11-04 (hq:images_videos_feed_4v87): on the /images and /videos feeds, three-digit
// reaction counts were cut off ("4:" for 432) with room left in the row, and the sticker count was
// a different size from the reactions. The feed card now uses the same action row as ImageCard.
const stats = { like: 432, heart: 321, laugh: 45, cry: 23, tip: 345 };
const maxed = { like: 999999, heart: 999999, laugh: 999999, cry: 999999, tip: 999999 };

// Two-column phone feed, desktop columns, one-column phone.
const WIDTHS = [181, 245, 320, 358];

const card = () => document.querySelector('[data-testid="shot"]')!;

async function renderCard(s: Record<string, number>, width: number) {
  renderWithProviders(
    <IntersectionObserverProvider>
      <div data-testid="shot" style={{ width }}>
        <ImagesCard data={imageData(s)} height={width * 1.2} />
      </div>
    </IntersectionObserverProvider>
  );
  await vi.waitFor(() => {
    expect(document.body.querySelectorAll('[aria-label$="reaction"]').length).toBeGreaterThan(0);
  });
}

// A clipped label keeps its full text in the DOM and loses the rest to overflow:hidden, so the
// check is on layout (the label is wider than its box), not on text.
function clippedLabels() {
  return [
    ...card().querySelectorAll<HTMLElement>('[class*="-Button-label"], [class*="-Badge-label"]'),
  ]
    .filter((el) => el.scrollWidth > el.clientWidth)
    .map((el) => el.textContent);
}

function overflowPastCard() {
  const right = card().getBoundingClientRect().right;
  return [...card().querySelectorAll('button, [class*="-Badge-root"]')]
    .filter((el) => el.getBoundingClientRect().right > right + 0.5)
    .map((el) => el.textContent);
}

describe('ImagesCard action row', () => {
  test.each(WIDTHS)('shows every count in full at %ipx', async (width) => {
    await renderCard(stats, width);

    expect(clippedLabels()).toEqual([]);
    expect(overflowPastCard()).toEqual([]);
    expect(document.body.querySelectorAll('[aria-label$="reaction"]')).toHaveLength(4);
    expect(card().textContent).toContain('345');
  });

  test.each(WIDTHS)('shows maxed counts in full at %ipx', async (width) => {
    await renderCard(maxed, width);

    expect(clippedLabels()).toEqual([]);
    expect(overflowPastCard()).toEqual([]);
  });

  test('puts the sticker and Buzz counts at the reaction count size', async () => {
    await renderCard(stats, 245);

    const fontOf = (el: Element | null) => (el ? getComputedStyle(el).fontSize : null);
    const reaction = document.body.querySelector(
      '[aria-label$="reaction"] [class*="-Button-label"]'
    );
    const sticker = card().querySelector('button[aria-label$="sticker"] p');
    const tip = card().querySelector('[class*="-Badge-label"]');
    expect(fontOf(sticker)).not.toBeNull();
    expect(fontOf(sticker)).toBe(fontOf(reaction));
    expect(fontOf(tip)).toBe(fontOf(reaction));
  });
});
