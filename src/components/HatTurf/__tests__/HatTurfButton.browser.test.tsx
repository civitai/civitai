import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
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
  stock: { available: 3, optedIn: true } as
    | { available: number; optedIn: boolean; cap?: number; nextAt?: Date | null; perHour?: number }
    | undefined,
  mutate: vi.fn(),
  optIn: vi.fn(),
  invalidate: vi.fn(async () => undefined),
  earns: vi.fn(async () => false),
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
            reactionEarns: { fetch: h.earns },
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
import { REACTION_NUDGE_DELAY_MS } from '~/components/HatTurf/reaction-nudge';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { renderWithProviders, LOADABLE_IMAGE_DATA_URI } from '../../../../test/component-setup';
import { cleanup } from 'vitest-browser-react';
import { stockRefreshTiming, useHatStock } from '~/components/HatTurf/useHatTurf';
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
        arm: 'control',
        team: 'blue',
        images: {},
        open: {},
        stickers: {},
        joined: h.stock?.optedIn === true,
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

/** The hat's body in the sticker editor: press it to drag, focus it for the arrow keys. */
const hatBody = () =>
  document.body.querySelector<HTMLElement>('[aria-label="Sticker position: arrow keys to move"]');
const placeHat = () =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Place hat')!.click();
const pointerAt = (type: string, x: number, y: number, target: EventTarget) =>
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, pointerId: 1, buttons: 1, clientX: x, clientY: y })
  );

describe('Hat Turf button on a feed ImageCard', () => {
  test('the button is a square in the team colour with only the hat, and the gear is already on screen', async () => {
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    const button = q('hat-turf-button')!.querySelector('button[aria-pressed]') as HTMLElement;
    expect(button.textContent).toBe('');
    const box = button.getBoundingClientRect();
    // The chips' height, so the tip row does not grow.
    expect(box.height).toBe(22);
    expect(box.width).toBe(26);
    // The viewer is on blue: the theme's blue at its primary shade (#228be6), not the grey fallback.
    expect(getComputedStyle(button).backgroundColor).toBe('rgb(34, 139, 230)');
    const gear = q('hat-turf-gear')!;
    expect(getComputedStyle(gear).backgroundColor).toBe('rgb(0, 0, 0)');
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

  test("the gear and the hat button never take each other's taps", async () => {
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    const gear = q('hat-turf-gear')!;
    const button = q('hat-turf-button')!.querySelector('button[aria-pressed]') as HTMLElement;
    const g = gear.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    const hit = (x: number, y: number) => document.elementFromPoint(x, y)?.closest('button');

    expect(hit(g.left + g.width / 2, g.top + g.height / 2)).toBe(gear);
    // The gear sits on the top-right; the centre and the rest of the circle stay the button's.
    const [cx, cy, r] = [b.left + b.width / 2, b.top + b.height / 2, b.width / 2 - 2];
    for (const [x, y] of [
      [cx, cy],
      [cx - r * Math.SQRT1_2, cy - r * Math.SQRT1_2],
      [cx - r * Math.SQRT1_2, cy + r * Math.SQRT1_2],
      [cx + r * Math.SQRT1_2, cy + r * Math.SQRT1_2],
    ])
      expect(hit(x, y)).toBe(button);
  });

  test('the hat button is a rounded square, not a circle', async () => {
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    const button = q('hat-turf-button')!.querySelector('button[aria-pressed]') as HTMLElement;
    // A rounded square still takes a tap 3px in from its corner; a circle does not.
    const b = button.getBoundingClientRect();
    const corner = document.elementFromPoint(b.left + 3, b.bottom - 3)?.closest('button');
    expect(corner).toBe(button);
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
    const layer = q('hat-turf-layer')!;
    const img = layer.parentElement!.querySelector('img')!;
    await vi.waitFor(() => {
      const body = hatBody()!;
      const hat = body.getBoundingClientRect();
      const media = img.getBoundingClientRect();
      pointerAt('pointerdown', hat.left + hat.width / 2, hat.top + hat.height / 2, body);
      pointerAt(
        'pointermove',
        media.left + media.width * 0.25,
        media.top + media.height * 0.3,
        window
      );
      pointerAt(
        'pointerup',
        media.left + media.width * 0.25,
        media.top + media.height * 0.3,
        window
      );
      expect(parseFloat(body.parentElement!.style.left)).toBeCloseTo(25, -1);
    });
    placeHat();
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
    // The reaction nudge asks about this image after its delay, never as part of the placement.
    expect(h.earns).not.toHaveBeenCalled();
    await vi.waitFor(
      () =>
        expect(h.earns).toHaveBeenCalledWith(
          { event: 'birthday2026', imageId: 77 },
          { staleTime: 0 }
        ),
      { timeout: REACTION_NUDGE_DELAY_MS + 2_000 }
    );
  });

  test('the draft hat moves with the arrow keys', async () => {
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    await press();
    await vi.waitFor(() => expect(q('hat-turf-draft')).not.toBeNull());
    await vi.waitFor(() => expect(hatBody()).not.toBeNull());
    const before = hatBody()!.parentElement!.style.left;
    hatBody()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await vi.waitFor(() => expect(hatBody()!.parentElement!.style.left).not.toBe(before));
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
    (document.body.querySelector('[aria-label="Remove this sticker"]') as HTMLElement).click();
    await vi.waitFor(() => expect(q('hat-turf-draft')).toBeNull());
    expect(h.mutate).not.toHaveBeenCalled();
  });

  test('at zero the button is greyed and pressing drops no hat', async () => {
    h.stock = { available: 0, optedIn: true };
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    expect(document.body.querySelector('[aria-label="No hats left to place"]')).not.toBeNull();
    await press();
    expect(q('hat-turf-draft')).toBeNull();
  });

  const faceOf = () => q('hat-turf-button')!.querySelector<HTMLElement>('button[aria-pressed]')!;
  // 12 minutes a hat.
  const PER_HOUR = 5;
  const PERIOD = 12 * 60_000;

  test('dual gauge: the background fills with hats held against the cap', async () => {
    h.stock = { available: 9, cap: 27, optedIn: true, nextAt: null, perHour: PER_HOUR };
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    // A third of the way up: team colour below, the dimmed colour above.
    expect(Number(faceOf().dataset.fill)).toBeCloseTo(1 / 3);
    expect(getComputedStyle(faceOf()).backgroundImage).toMatch(
      /linear-gradient\(to top, .*33\.33\d*%/
    );
  });

  test('dual gauge: the timer is how far the wait for the next hat has gone', async () => {
    h.stock = {
      available: 9,
      cap: 27,
      optedIn: true,
      nextAt: new Date(Date.now() + PERIOD / 4),
      perHour: PER_HOUR,
    };
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-refill-timer')).not.toBeNull());
    // Three quarters of a hat's wait has passed: the bar is drawn three quarters along its track,
    // inside the button.
    const track = q('hat-turf-refill-timer')!.firstElementChild!;
    const bar = track.firstElementChild!.getBoundingClientRect();
    const t = track.getBoundingClientRect();
    const b = faceOf().getBoundingClientRect();
    // The fill slides in from the left, clipped by its track: what shows is its right edge's reach.
    expect((bar.right - t.left) / t.width).toBeCloseTo(0.75, 1);
    expect(t.bottom).toBeLessThanOrEqual(b.bottom);
    expect(t.left).toBeGreaterThanOrEqual(b.left);
    expect(t.right).toBeLessThanOrEqual(b.right);
  });

  test('at the cap no hat is coming, so no timer', async () => {
    h.stock = { available: 27, cap: 27, optedIn: true, nextAt: null, perHour: PER_HOUR };
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    expect(Number(faceOf().dataset.fill)).toBe(1);
    expect(q('hat-turf-refill-timer')).toBeNull();
  });

  test('out of hats: the timer still shows, since it is what the viewer waits on', async () => {
    h.stock = {
      available: 0,
      cap: 27,
      optedIn: true,
      nextAt: new Date(Date.now() + PERIOD / 2),
      perHour: PER_HOUR,
    };
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-refill-timer')).not.toBeNull());
    expect(Number(faceOf().dataset.fill)).toBe(0);
  });

  test('not joined: no gauges', async () => {
    h.stock = {
      available: 9,
      cap: 27,
      optedIn: false,
      nextAt: new Date(Date.now() + PERIOD / 2),
      perHour: PER_HOUR,
    };
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    expect(faceOf().dataset.fill).toBeUndefined();
    expect(q('hat-turf-refill-timer')).toBeNull();
  });

  // Every card on a feed reads the stock: the reread when a hat is due must happen once, not per card.
  test('when the next hat is due the stock is reread once, however many cards show it', async () => {
    h.stock = {
      available: 9,
      cap: 27,
      optedIn: true,
      nextAt: new Date(Date.now() + 100),
      perHour: PER_HOUR,
    };
    function Reader() {
      useHatStock();
      return null;
    }
    renderWithProviders(
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
        <Reader />
        <Reader />
        <Reader />
      </TurfSummaryContext.Provider>
    );
    h.invalidate.mockClear();
    await new Promise((r) => setTimeout(r, 1200));
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  // The due-time reread must survive what a feed does to it: cards mounting after it fired, and a
  // reread that brings back the same due time (a client clock ahead of the server) or fails.
  test('a card mounting after the reread adds none; a reread that changes nothing is retried', async () => {
    h.stock = {
      available: 9,
      cap: 27,
      optedIn: true,
      nextAt: new Date(Date.now() + 100),
      perHour: PER_HOUR,
    };
    const retryMs = stockRefreshTiming.retryMs;
    stockRefreshTiming.retryMs = 1500;
    try {
      let addReader: (() => void) | undefined;
      function Reader() {
        useHatStock();
        return null;
      }
      function Readers() {
        const [count, setCount] = useState(2);
        addReader = () => setCount((n) => n + 1);
        return (
          <>
            {Array.from({ length: count }, (_, i) => (
              <Reader key={i} />
            ))}
          </>
        );
      }
      renderWithProviders(
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
          <Readers />
        </TurfSummaryContext.Provider>
      );
      h.invalidate.mockClear();
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      await wait(800);
      expect(h.invalidate).toHaveBeenCalledTimes(1);
      // A reread never cancels one already in flight: cards mounting mid-read would starve it.
      expect(h.invalidate).toHaveBeenLastCalledWith(undefined, undefined, { cancelRefetch: false });
      // The stock read still says the same due time: a card mounting now schedules nothing.
      addReader!();
      await wait(800);
      expect(h.invalidate).toHaveBeenCalledTimes(1);
      // Nothing moved the due time on: the reread is tried again, rather than the bar freezing full.
      await wait(1000);
      expect(h.invalidate).toHaveBeenCalledTimes(2);
    } finally {
      stockRefreshTiming.retryMs = retryMs;
    }
  });

  test('the gear opens the panel; a hat picked in its tray is the one placed', async () => {
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-gear')).not.toBeNull());
    q('hat-turf-gear')!.click();
    await vi.waitFor(() => expect(q('hat-turf-panel-hat')?.textContent).toBe('Party Cap'));
    expect(onCardClick).not.toHaveBeenCalled();
    q('hat-turf-panel-change')!.click();
    await vi.waitFor(() => expect(q('hat-turf-tray')).not.toBeNull());
    const option = [...q('hat-turf-tray')!.querySelectorAll('button[aria-pressed]')].find((o) =>
      o.textContent?.includes('Top Hat')
    ) as HTMLElement;
    option.click();
    await vi.waitFor(() => expect(q('hat-turf-panel-hat')?.textContent).toBe('Top Hat'));
    await press();
    await vi.waitFor(() => expect(q('hat-turf-draft')).not.toBeNull());
    placeHat();
    expect(h.mutate.mock.calls[0][0].cosmeticId).toBe(12);
  });

  test('the viewer can place a hat on their own image', async () => {
    renderCard({}, 1);
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
  });

  test('joined: no button on an image that cannot take a hat (owner not opted in)', async () => {
    renderCard({ open: { 77: false } });
    await cardRendered();
    expect(q('hat-turf-button')).toBeNull();
  });

  test('not joined: a contest entry offers no Join either', async () => {
    h.stock = { available: 3, optedIn: false };
    renderCard({ open: { 77: false }, hidden: { 77: true } });
    await cardRendered();
    expect(q('hat-turf-button')).toBeNull();
  });

  // Until the stock is read, the card cannot tell a joined viewer's hat from the join invite, and a
  // hat press there would start a placement that no layer draws.
  test('no button until the viewer’s stock is read', async () => {
    h.stock = undefined;
    renderCard();
    await cardRendered();
    expect(q('hat-turf-button')).toBeNull();
  });

  // The control for the absences above: by the time the reactions are drawn, the button is too.
  test('joined: the button is drawn by the time the reactions are', async () => {
    renderCard();
    await cardRendered();
    expect(q('hat-turf-button')).not.toBeNull();
  });

  test('not joined: a closed image still offers Join', async () => {
    h.stock = { available: 3, optedIn: false };
    renderCard({ open: { 77: false } });
    await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
    await press();
    const join = await vi.waitFor(() => {
      const button = [...document.body.querySelectorAll('button')].find(
        (b) => b.textContent === 'Join Hat Turf'
      );
      expect(button).toBeDefined();
      return button as HTMLElement;
    });
    join.click();
    expect(h.optIn).toHaveBeenCalledWith({ event: 'birthday2026', optedIn: true });
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
    // Not joined has nothing to set yet: no gear.
    expect(q('hat-turf-gear')).toBeNull();
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
    hattedTeam: null,
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

  test('a protected image shows its hats muted, with no "would take it" pill', async () => {
    renderCard({
      images: { 77: summary({ hatted: true }) },
      stickers: { 77: [sticker(1, 'blue')] },
    });
    await vi.waitFor(() => expect(hats().length).toBe(1));
    expect(hats()[0].dataset.tone).toBe('muted');
    expect(getComputedStyle(hats()[0]).filter).not.toMatch(/grayscale|saturate/);
    expect(q('hat-turf-badge-lock')).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/would take it/);
  });

  test('hats past what is drawn show no +N chip on a feed card', async () => {
    renderCard({
      images: {
        77: summary({ shown: { blue: 9, pink: 3 }, counted: { blue: 9, pink: 3 }, leader: 'blue' }),
      },
      stickers: { 77: [sticker(1, 'blue'), sticker(2, 'pink')] },
    });
    await vi.waitFor(() =>
      expect(document.body.querySelectorAll('[data-testid="hat-turf-hat"]').length).toBe(2)
    );
    expect(q('hat-turf-more')).toBeNull();
  });

  test('turning Show hats off in the gear menu logs it, and the card keeps its hat button and gear', async () => {
    renderCard();
    await vi.waitFor(() => expect(q('hat-turf-gear')).not.toBeNull());
    q('hat-turf-gear')!.click();
    await vi.waitFor(() =>
      expect(document.body.querySelector('input[type="checkbox"]')).not.toBeNull()
    );
    (document.body.querySelector('input[type="checkbox"]') as HTMLElement).click();
    await vi.waitFor(() => expect(useHatTurfStore.getState().showHats).toBe(false));
    // Give a removal the time to land before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(q('hat-turf-gear')).not.toBeNull();
    expect(q('hat-turf-button')).not.toBeNull();
    expect(actions()).toEqual(['hide_all_hats_on']);
  });

  // Tester report 2026-11-06: a resting hat on the corner covered the Hat Turf badge. The card's
  // header and footer are later, unstacked siblings of the hat layer, so the layer must take no
  // z-index of its own on a feed card; a z-index there lifts every hat over every chip.
  describe('a resting hat sits under the card chips', () => {
    // Hats and the control-arm badge take no taps, so hit-testing cannot see them unless forced.
    let restore: () => void = () => undefined;
    beforeEach(() => {
      const style = document.createElement('style');
      style.textContent =
        '[data-testid="hat-turf-hat"], [data-testid="hat-turf-hat"] *, [data-testid="hat-turf-badge"] { pointer-events: auto !important; }';
      document.head.appendChild(style);
      restore = () => style.remove();
    });
    afterEach(() => restore());

    const big = (x: number, y: number) => ({
      ...sticker(1, 'blue'),
      data: { x, y, scale: 0.6, rotation: 0, flip: false },
    });
    const topAt = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    };
    const hatCovers = (el: HTMLElement) => {
      const hat = hats()[0].getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
      return x > hat.left && x < hat.right && y > hat.top && y < hat.bottom;
    };

    // Hovered, the card's zoom transforms the hat layer, which makes it a stacking context.
    test.each([false, true])('the badge, top left (hovered: %s)', async (hovered) => {
      renderCard({ images: { 77: summary() }, stickers: { 77: [big(0.15, 0.1)] } });
      await vi.waitFor(() => expect(hats()[0]?.getBoundingClientRect().width).toBeGreaterThan(0));
      const badge = await vi.waitFor(() => q('hat-turf-badge')!);
      if (hovered) {
        await userEvent.hover(document.body.querySelector<HTMLElement>('[data-card-hover]')!);
        await vi.waitFor(() =>
          expect(getComputedStyle(q('hat-turf-layer')!).transform).not.toBe('none')
        );
      }
      expect(hatCovers(badge), 'the hat is not over the badge: the test proves nothing').toBe(true);
      expect(badge.contains(topAt(badge)), 'a hat paints over the badge').toBe(true);
    });

    test('the hat button, bottom right', async () => {
      renderCard({ images: { 77: summary() }, stickers: { 77: [big(0.8, 0.9)] } });
      await vi.waitFor(() => expect(hats()[0]?.getBoundingClientRect().width).toBeGreaterThan(0));
      const button = q('hat-turf-button')!.querySelector<HTMLElement>('button[aria-pressed]')!;
      expect(hatCovers(button), 'the hat is not over the button: the test proves nothing').toBe(
        true
      );
      expect(button.contains(topAt(button)), 'a hat paints over the hat button').toBe(true);
    });
  });

  describe('Show hats off, and the reveal', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const t0 = Date.parse('2026-11-01T00:00:00Z');
    // Newest first, as the reads return them: 3 went on a day after 2, which went an hour after 1.
    const timed = () => [
      { ...sticker(3, 'pink'), createdAt: new Date(t0 + DAY + 3_600_000) },
      { ...sticker(2, 'pink'), createdAt: new Date(t0 + 3_600_000) },
      { ...sticker(1, 'blue'), createdAt: new Date(t0) },
    ];
    const delayOf = (hat: HTMLElement) => {
      const wrap = hat.querySelector<HTMLElement>('[class*="appear"]');
      return wrap ? parseFloat(wrap.style.getPropertyValue('--sticker-delay')) : null;
    };
    const ids = () => hats().map((el) => el.dataset.team);

    test('hats on screen at load play no reveal; turning Show hats on plays it', async () => {
      renderCard({ images: { 77: summary() }, stickers: { 77: timed() } });
      await vi.waitFor(() => expect(hats().length).toBe(3));
      expect(hats().map(delayOf)).toEqual([null, null, null]);

      useHatTurfStore.setState({ showHats: false });
      await vi.waitFor(() => expect(hats().length).toBe(0));
      useHatTurfStore.setState({ showHats: true });
      await vi.waitFor(() => expect(hats().length).toBe(3));
      expect(
        hats()
          .map(delayOf)
          .every((d) => d !== null)
      ).toBe(true);
    });

    test('with Show hats off, the hat button reveals every hat, oldest first, within 1.5s', async () => {
      useHatTurfStore.setState({ showHats: false });
      renderCard({ images: { 77: summary() }, stickers: { 77: timed() } });
      await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(hats()).toHaveLength(0);

      await press();
      await vi.waitFor(() => expect(q('hat-turf-draft')).not.toBeNull());
      await vi.waitFor(() => expect(hats()).toHaveLength(3));
      expect(ids()).toEqual(['pink', 'pink', 'blue']);
      const [d3, d2, d1] = hats().map(delayOf) as number[];
      expect(d1).toBe(0);
      expect(d2).toBeGreaterThan(d1);
      // A day's gap runs longer than an hour's, and the whole reveal stays inside 1.5s.
      expect(d3 - d2).toBeGreaterThan(d2 - d1);
      expect(d3).toBeLessThanOrEqual(1500);
    });

    test('when placing ends with Show hats off, the hats stay about 2s, then go', async () => {
      useHatTurfStore.setState({ showHats: false });
      renderCard({ images: { 77: summary() }, stickers: { 77: timed() } });
      await vi.waitFor(() => expect(q('hat-turf-button')).not.toBeNull());
      await press();
      await vi.waitFor(() => expect(hats()).toHaveLength(3));

      (document.body.querySelector('[aria-label="Remove this sticker"]') as HTMLElement).click();
      await vi.waitFor(() => expect(q('hat-turf-draft')).toBeNull());
      const ended = performance.now();
      // Read at once, not awaited: the linger ends by itself.
      expect(hats()).toHaveLength(3);
      await vi.waitFor(() => expect(hats()).toHaveLength(0), { timeout: 5000 });
      expect(performance.now() - ended).toBeGreaterThanOrEqual(2000);
    });
  });

  test('tells the provider the card is on screen, and stops when it leaves', async () => {
    const stop = vi.fn();
    const watch = vi.fn(() => stop);
    const view = await renderWithProviders(
      <TurfSummaryContext.Provider
        value={{
          event: 'birthday2026',
          arm: 'control',
          team: 'blue',
          images: {},
          open: {},
          stickers: {},
          joined: true,
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
