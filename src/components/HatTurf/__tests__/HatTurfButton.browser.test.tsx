import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as CardStickerOverlayModule from '~/components/Sticker/CardStickerOverlay';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsModule from '~/providers/BrowserSettingsProvider';
import type * as TrackUtilsModule from '~/components/TrackView/track.utils';

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
import type { TurfSummaries } from '~/components/HatTurf/TurfSummaryProvider';
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

type Ctx = Partial<TurfSummaries>;
function renderCard(ctx: Ctx = {}, ownerId = 2, width = PHONE_CARD) {
  renderWithProviders(
    <TurfSummaryContext.Provider
      value={{
        event: 'birthday2026',
        team: 'blue',
        images: {},
        open: {},
        stickers: {},
        watch: () => () => undefined,
        ...ctx,
      }}
    >
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
const actions = () =>
  h.trackAction.mock.calls.map(
    ([data]) => (data as { details: { action: string } }).details.action
  );
const press = async () => {
  (
    document.body.querySelector(
      '[data-testid="hat-turf-button"] button[aria-pressed]'
    ) as HTMLElement
  ).click();
};

beforeEach(() => {
  h.stock = { available: 3, optedIn: true };
  h.user = { id: 1 };
  h.mutate.mockReset();
  h.optIn.mockReset();
  h.invalidate.mockClear();
  h.trackAction.mockClear();
  onCardClick.mockClear();
  useHatTurfStore.setState({ cosmeticId: null, showHats: true });
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
    await press();
    expect(actions()).toEqual(['feed_place_start']);
    expect(h.trackAction).toHaveBeenCalledWith({
      type: 'HatTurf_Action',
      details: { action: 'feed_place_start', event: 'birthday2026', surface: 'feed-card' },
    });
  });

  test('drag then tick saves one hat at that spot with the default size', async () => {
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    await press();
    await vi.waitFor(() => expect(q('hat-turf-draft')).not.toBeNull());
    const draft = q('hat-turf-draft')!;
    const layer = q('hat-turf-layer')!;
    const img = layer.parentElement!.querySelector('img')!;
    await vi.waitFor(() => {
      const media = img.getBoundingClientRect();
      draft.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          buttons: 1,
          pointerType: 'mouse',
          clientX: media.left + media.width * 0.25,
          clientY: media.top + media.height * 0.3,
        })
      );
      expect(parseFloat(q('hat-turf-draft')!.style.left)).toBeCloseTo(25, -1);
    });
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
    expect(actions()).not.toContain('feed_place_save');
    // The server accepted it: the hat stays, the button says placed, stock is refetched.
    options.onSuccess();
    expect(actions()).toEqual(['feed_place_start', 'feed_place_save']);
    await vi.waitFor(() => expect(q('hat-turf-placed')).not.toBeNull());
    expect(q('hat-turf-draft')).toBeNull();
    expect(document.body.querySelector('[aria-label="Your hat is placed here"]')).not.toBeNull();
    expect(h.invalidate).toHaveBeenCalled();
  });

  test('the draft hat moves with the arrow keys', async () => {
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    await press();
    await vi.waitFor(() => expect(q('hat-turf-draft')).not.toBeNull());
    const before = q('hat-turf-draft')!.style.left;
    q('hat-turf-draft')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
    );
    await vi.waitFor(() => expect(q('hat-turf-draft')!.style.left).not.toBe(before));
  });

  test('the layer rides the card’s hover zoom and clips to the card', async () => {
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    await press();
    await vi.waitFor(() => expect(q('hat-turf-layer')).not.toBeNull());
    expect(q('hat-turf-layer')!.hasAttribute('data-sticker-overlay')).toBe(true);
    expect(getComputedStyle(q('hat-turf-layer')!).overflow).toBe('hidden');
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
    h.stock = { available: 0, optedIn: true };
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
    const option = [...document.body.querySelectorAll('[aria-label="Hat to place"] button')].find(
      (o) => o.textContent?.includes('Top Hat')
    ) as HTMLElement;
    option.click();
    await press();
    await vi.waitFor(() => expect(q('hat-turf-draft')).not.toBeNull());
    (document.body.querySelector('[aria-label^="Place hat"]') as HTMLElement).click();
    expect(h.mutate.mock.calls[0][0].cosmeticId).toBe(12);
  });

  test('the viewer can place a hat on their own image', async () => {
    renderCard({}, 1);
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
  });

  test('no button when the image cannot take a hat (owner not opted in)', async () => {
    renderCard({ open: { 77: false } });
    await cardRendered();
    expect(q('hat-turf-button')).toBeNull();
  });

  test('no button when signed out', async () => {
    h.user = null;
    renderCard();
    await cardRendered();
    expect(q('hat-turf-button')).toBeNull();
  });

  test('not joined: the button shows + and opens the join offer instead of a hat', async () => {
    h.stock = { available: 3, optedIn: false };
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    expect(q('hat-turf-stock')!.textContent).toBe('+');
    await press();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Join Hat Turf to place hats')
    );
    expect(q('hat-turf-draft')).toBeNull();
    const join = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === 'Join Hat Turf'
    ) as HTMLElement;
    join.click();
    expect(h.optIn).toHaveBeenCalledWith({ event: 'birthday2026', optedIn: true });
  });

  test('a hat the viewer already has on this image reads as placed and cannot be dropped again', async () => {
    renderCard({
      stickers: {
        77: [{ id: 1, userId: 1, team: 'blue', cosmeticId: 11, data: { x: 0.4, y: 0.4 } }],
      },
    });
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    expect(document.body.querySelector('[aria-label="Your hat is placed here"]')).not.toBeNull();
    await press();
    expect(q('hat-turf-draft')).toBeNull();
  });
});

describe('hats on a feed ImageCard', () => {
  const summary = (over = {}) => ({
    shown: { blue: 2, pink: 3 },
    counted: { blue: 2, pink: 3 },
    leader: 'pink',
    leaderCosmeticId: 11,
    hatted: false,
    ...over,
  });
  const sticker = (id: number, team: string, userId = 9) => ({
    id,
    userId,
    team,
    cosmeticId: 11,
    data: { x: 0.2 + id * 0.1, y: 0.4, scale: 0.2, rotation: 0, flip: false },
  });
  const hats = () =>
    [...document.body.querySelectorAll('[data-testid="hat-turf-hat"]')] as HTMLElement[];

  test('the leading team’s hats are lit and the others dim', async () => {
    renderCard({
      images: { 77: summary() },
      stickers: { 77: [sticker(1, 'blue'), sticker(2, 'pink'), sticker(3, 'pink')] },
    });
    await vi.waitFor(() => expect(hats().length).toBe(3));
    expect(hats().map((el) => [el.dataset.team, el.dataset.tone])).toEqual([
      ['blue', 'dim'],
      ['pink', 'lead'],
      ['pink', 'lead'],
    ]);
  });

  test('when the lead changes, the same hats swap tones', async () => {
    renderCard({
      images: { 77: summary({ leader: 'blue' }) },
      stickers: { 77: [sticker(1, 'blue'), sticker(2, 'pink')] },
    });
    await vi.waitFor(() => expect(hats().length).toBe(2));
    // The same two hats as the test above, with the lead the other way round.
    expect(hats().map((el) => el.dataset.tone)).toEqual(['lead', 'dim']);
  });

  test('a protected image shows its hats muted with a lock and who would take it', async () => {
    renderCard({
      images: { 77: summary({ hatted: true }) },
      stickers: { 77: [sticker(1, 'blue')] },
    });
    await vi.waitFor(() => expect(hats().length).toBe(1));
    expect(hats()[0].dataset.tone).toBe('muted');
    expect(q('hat-turf-lock')!.textContent).toContain('Pink would take it');
  });

  test('hats past what is drawn show as a +N chip', async () => {
    renderCard({
      images: {
        77: summary({ shown: { blue: 9, pink: 3 }, counted: { blue: 9, pink: 3 }, leader: 'blue' }),
      },
      stickers: { 77: [sticker(1, 'blue'), sticker(2, 'pink')] },
    });
    await vi.waitFor(() => expect(q('hat-turf-more')).not.toBeNull());
    expect(q('hat-turf-more')!.textContent).toContain('+10');
  });

  test('Show hats off hides the hats but the badge stays', async () => {
    useHatTurfStore.setState({ showHats: false });
    renderCard({
      images: { 77: summary() },
      stickers: { 77: [sticker(1, 'blue')] },
    });
    await vi.waitFor(() => expect(q('hat-turf-badge')).not.toBeNull());
    expect(hats().length).toBe(0);
    useHatTurfStore.setState({ showHats: true });
  });

  test('turning Show hats off and on again in the gear menu logs both', async () => {
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-gear')).not.toBeNull());
    q('hat-turf-gear')!.click();
    const toggle = () =>
      (document.body.querySelector('input[type="checkbox"]') as HTMLElement).click();
    await vi.waitFor(() =>
      expect(document.body.querySelector('input[type="checkbox"]')).not.toBeNull()
    );
    toggle();
    await vi.waitFor(() => expect(useHatTurfStore.getState().showHats).toBe(false));
    toggle();
    await vi.waitFor(() => expect(useHatTurfStore.getState().showHats).toBe(true));
    expect(actions()).toEqual(['hide_all_hats_on', 'hide_all_hats_off']);
  });

  test('tells the provider the card is on screen, and stops when it leaves', async () => {
    const stop = vi.fn();
    const watch = vi.fn(() => stop);
    const view = await renderWithProviders(
      <TurfSummaryContext.Provider
        value={{
          event: 'birthday2026',
          team: 'blue',
          images: {},
          open: {},
          stickers: {},
          watch,
        }}
      >
        <IntersectionObserverProvider>
          <div style={{ width: PHONE_CARD }}>
            <ImageCard data={image()} />
          </div>
        </IntersectionObserverProvider>
      </TurfSummaryContext.Provider>
    );
    await vi.waitFor(() => expect(watch).toHaveBeenCalledWith(77));
    await view.unmount();
    expect(stop).toHaveBeenCalled();
  });
});
