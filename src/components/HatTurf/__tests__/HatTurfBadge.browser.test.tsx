import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsModule from '~/providers/BrowserSettingsProvider';

// The component project loads no global stylesheet, so Tailwind — including
// preflight's `box-sizing: border-box` — is inert unless a test imports it.
// Without this the card's footer measures 16px WIDER than the card and every
// utility class in the footer row is dead, which is a different layout from the
// one that ships. The wrap assertion below is only meaningful with it.
import '~/styles/globals.css';

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
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof Trpc>()), trpc: makeTrpcProxy() };
});
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, isModerator: false, muted: false, filePreferences: {} }),
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
vi.mock('~/components/Sticker/CardStickerOverlay', () => ({ CardStickerOverlay: () => null }));
vi.mock('~/components/Buzz/InteractiveTipBuzzButton', () => ({
  InteractiveTipBuzzButton: ({ children }: { children: ReactNode }) => <>{children}</>,
  useBuzzTippingStore: () => 0,
}));

import { ImageCard } from '~/components/Cards/ImageCard';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { TurfSummaryContext } from '~/components/HatTurf/TurfSummaryProvider';
import type { TurfSummaries } from '~/components/HatTurf/TurfSummaryProvider';
import { renderWithProviders, LOADABLE_IMAGE_DATA_URI } from '../../../../test/component-setup';
import { cleanup } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { MediaType } from '~/shared/utils/prisma/enums';

const PHONE_CARD = 171; // a 2-up grid on a 390px phone
const DESKTOP_CARD = 300;

const image = {
  id: 1,
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
} as any;

const counted = { blue: 6, pink: 4, green: 2, yellow: 1 };
const standing = (over: Partial<TurfSummaries['images'][number]> = {}) => ({
  shown: counted,
  counted,
  leader: 'blue',
  leaderCosmeticId: 11,
  hatted: false,
  ...over,
});

function renderCard(opts: {
  width?: number;
  feed?: TurfSummaries | null;
  scheme?: 'light' | 'dark';
}) {
  const { width = PHONE_CARD, feed, scheme = 'dark' } = opts;
  document.documentElement.setAttribute('data-mantine-color-scheme', scheme);
  renderWithProviders(
    <TurfSummaryContext.Provider value={feed === undefined ? null : feed}>
      <IntersectionObserverProvider>
        <div data-testid="card-root" style={{ width }}>
          <ImageCard data={image} />
        </div>
      </IntersectionObserverProvider>
    </TurfSummaryContext.Provider>
  );
}

const badge = () =>
  document.body.querySelector('[data-testid="hat-turf-badge"]') as HTMLElement | null;
const feedWith = (
  images: TurfSummaries['images'],
  team: string | null = 'blue'
): TurfSummaries => ({
  event: 'birthday2026',
  team,
  images,
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-mantine-color-scheme');
});

describe('Hat Turf badge on a feed ImageCard', () => {
  test('draws the ring, the leader colour, a white hat and the count under it', async () => {
    renderCard({ feed: feedWith({ 1: standing() }) });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    const el = badge()!;
    expect(el.dataset.leader).toBe('blue');
    // One arc per team, in the ring's SVG.
    expect(el.querySelectorAll('circle[data-team]').length).toBe(4);
    expect(el.querySelector('[data-testid="hat-turf-count"]')!.textContent).toBe('6');
    // The disc is filled with the leader's colour, not white.
    const disc = el.querySelector('[data-testid="hat-turf-count"]')!.parentElement as HTMLElement;
    const bg = getComputedStyle(disc).backgroundColor;
    expect(bg).not.toBe('rgb(255, 255, 255)');
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(el.getAttribute('aria-label')).toContain('blue leads with 6');
    // The badge sits inside the card, top left, and stays inside it.
    const card = document.querySelector('[data-testid="card-root"]')!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    expect(box.left - card.left).toBeLessThan(16);
    expect(box.top - card.top).toBeLessThan(16);
    expect(box.right).toBeLessThanOrEqual(card.right);
  });

  test('shows where the viewer stands when their team is behind', async () => {
    renderCard({ feed: feedWith({ 1: standing() }, 'pink') });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    expect(badge()!.textContent).toContain('you 4');
  });

  test('says nothing extra when the viewer leads', async () => {
    renderCard({ feed: feedWith({ 1: standing() }, 'blue') });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    expect(badge()!.textContent).not.toContain('you');
  });

  // The card itself must be on screen first, or "no badge" would also pass for a card that never rendered.
  const cardRendered = () =>
    vi.waitFor(() =>
      expect(document.body.querySelector('[aria-label$="reaction"]')).not.toBeNull()
    );

  test('is absent for an image with no turf', async () => {
    renderCard({ feed: feedWith({}) });
    await cardRendered();
    expect(badge()).toBeNull();
  });

  test('is absent when Hat Turf is off for the viewer', async () => {
    renderCard({ feed: null });
    await cardRendered();
    expect(badge()).toBeNull();
  });

  test('an image with stickers but no counted hats gets the neutral badge', async () => {
    renderCard({
      feed: feedWith({
        1: standing({ counted: { blue: 0, pink: 0 }, shown: { blue: 2 }, leader: null }),
      }),
    });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    expect(badge()!.dataset.leader).toBe('');
    expect(badge()!.querySelector('[data-testid="hat-turf-count"]')).toBeNull();
  });

  test('four large counts still fit the disc', async () => {
    renderCard({
      feed: feedWith({ 1: standing({ counted: { blue: 1240, pink: 980 }, leader: 'blue' }) }),
    });
    await vi.waitFor(() => expect(badge()).not.toBeNull());
    const count = badge()!.querySelector('[data-testid="hat-turf-count"]') as HTMLElement;
    const disc = count.parentElement!;
    expect(count.getBoundingClientRect().width).toBeLessThanOrEqual(
      disc.getBoundingClientRect().width
    );
  });
});
