import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as CardStickerOverlayModule from '~/components/Sticker/CardStickerOverlay';
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
const h = vi.hoisted(() => ({
  stock: { available: 3 },
  mutate: vi.fn(),
  invalidate: vi.fn(async () => undefined),
  user: { id: 1 } as { id: number } | null,
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
      },
      {
        useUtils: () => ({
          hatTurf: {
            getStock: { invalidate: h.invalidate },
            getSummaries: { invalidate: h.invalidate },
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

import { ImageCard } from '~/components/Cards/ImageCard';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { TurfSummaryContext } from '~/components/HatTurf/TurfSummaryProvider';
import { STICKER_PLACEMENT_MAX_SCALE } from '~/shared/utils/sticker-placement';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { renderWithProviders, LOADABLE_IMAGE_DATA_URI } from '../../../../test/component-setup';
import { cleanup } from 'vitest-browser-react';
import { MediaType } from '~/shared/utils/prisma/enums';

const PHONE_CARD = 171;
const onCardClick = vi.fn();

const image = (ownerId = 2) =>
  ({
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
    user: { id: ownerId, username: 'someone' },
    stats: { likeCountAllTime: 1082, heartCountAllTime: 12400, tippedAmountCountAllTime: 25000 },
  } as any);

function renderCard(ownerId = 2, width = PHONE_CARD) {
  renderWithProviders(
    <TurfSummaryContext.Provider value={{ event: 'birthday2026', team: 'blue', images: {} }}>
      <IntersectionObserverProvider>
        <div data-testid="card-root" style={{ width }} onClick={onCardClick}>
          <ImageCard data={image(ownerId)} />
        </div>
      </IntersectionObserverProvider>
    </TurfSummaryContext.Provider>
  );
}

const q = (id: string) =>
  document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const cardRendered = () =>
  vi.waitFor(() => expect(document.body.querySelector('[aria-label$="reaction"]')).not.toBeNull());
const press = async () => {
  (
    document.body.querySelector(
      '[data-testid="hat-turf-button"] button[aria-pressed]'
    ) as HTMLElement
  ).click();
};

beforeEach(() => {
  h.stock = { available: 3 };
  h.user = { id: 1 };
  h.mutate.mockReset();
  h.invalidate.mockClear();
  onCardClick.mockClear();
  useHatTurfStore.setState({ cosmeticId: null });
});
afterEach(() => cleanup());

describe('Hat Turf button on a feed ImageCard', () => {
  test('shows how many hats are available before pressing, and the gear is already on screen', async () => {
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    expect(q('hat-turf-stock')!.textContent).toBe('3');
    const gear = q('hat-turf-gear')!;
    expect(getComputedStyle(gear).display).not.toBe('none');
    const card = q('card-root')!.getBoundingClientRect();
    const g = gear.getBoundingClientRect();
    const b = q('hat-turf-button')!.getBoundingClientRect();
    expect(g.width).toBeGreaterThan(0);
    // Both stay inside a 171px phone card.
    for (const r of [g, b]) {
      expect(r.left).toBeGreaterThanOrEqual(card.left);
      expect(r.right).toBeLessThanOrEqual(card.right);
    }
  });

  test('pressing drops a draft hat on the picture without opening the card', async () => {
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    await press();
    await vi.waitFor(() => expect(q('hat-turf-draft')).not.toBeNull());
    expect(onCardClick).not.toHaveBeenCalled();
    expect(h.mutate).not.toHaveBeenCalled();
  });

  test('drag then tick saves one hat at that spot with the default size', async () => {
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    await press();
    await vi.waitFor(() => expect(q('hat-turf-draft')).not.toBeNull());
    const draft = q('hat-turf-draft')!;
    const layer = q('hat-turf-layer')!;
    const media = layer.parentElement!.querySelector('img')!.getBoundingClientRect();
    draft.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        buttons: 1,
        pointerType: 'mouse',
        clientX: media.left + media.width * 0.25,
        clientY: media.top + media.height * 0.3,
      })
    );
    await vi.waitFor(() => expect(q('hat-turf-draft')!.style.left).toBe('25%'));
    (document.body.querySelector('[aria-label^="Place hat"]') as HTMLElement).click();
    expect(h.mutate).toHaveBeenCalledTimes(1);
    const [input, options] = h.mutate.mock.calls[0];
    expect(input).toMatchObject({
      event: 'birthday2026',
      imageId: 77,
      cosmeticId: 11,
      data: { rotation: 0, flip: false },
    });
    // A size the server accepts, and big enough to read as a hat on a card.
    expect(input.data.scale).toBeGreaterThanOrEqual(0.15);
    expect(input.data.scale).toBeLessThanOrEqual(STICKER_PLACEMENT_MAX_SCALE);
    expect(input.data.x).toBeCloseTo(0.25, 1);
    expect(input.data.y).toBeCloseTo(0.3, 1);
    // The server accepted it: the hat stays, the button says placed, stock is refetched.
    options.onSuccess();
    await vi.waitFor(() => expect(q('hat-turf-placed')).not.toBeNull());
    expect(q('hat-turf-draft')).toBeNull();
    expect(document.body.querySelector('[aria-label="Your hat is placed here"]')).not.toBeNull();
    expect(h.invalidate).toHaveBeenCalled();
  });

  test('the cross discards the draft and places nothing', async () => {
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    await press();
    await vi.waitFor(() => expect(q('hat-turf-draft')).not.toBeNull());
    (document.body.querySelector('[aria-label="Discard hat"]') as HTMLElement).click();
    await vi.waitFor(() => expect(q('hat-turf-draft')).toBeNull());
    expect(h.mutate).not.toHaveBeenCalled();
  });

  test('at zero the button is greyed and pressing drops no hat', async () => {
    h.stock = { available: 0 };
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    expect(q('hat-turf-stock')!.textContent).toBe('0');
    expect(document.body.querySelector('[aria-label="No hats left to place"]')).not.toBeNull();
    await press();
    expect(q('hat-turf-draft')).toBeNull();
  });

  test('the gear lists the viewer’s hats by name and the pick is the one placed', async () => {
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-gear')).not.toBeNull());
    q('hat-turf-gear')!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Top Hat'));
    expect(document.body.textContent).toContain('Party Cap');
    const option = [...document.body.querySelectorAll('[role="option"]')].find((o) =>
      o.textContent?.includes('Top Hat')
    ) as HTMLElement;
    option.click();
    await press();
    await vi.waitFor(() => expect(q('hat-turf-draft')).not.toBeNull());
    (document.body.querySelector('[aria-label^="Place hat"]') as HTMLElement).click();
    expect(h.mutate.mock.calls[0][0].cosmeticId).toBe(12);
  });

  test('no button on the viewer’s own image', async () => {
    renderCard(1);
    await cardRendered();
    expect(q('hat-turf-button')).toBeNull();
  });

  test('no button when signed out', async () => {
    h.user = null;
    renderCard();
    await cardRendered();
    expect(q('hat-turf-button')).toBeNull();
  });
});
