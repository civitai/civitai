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

const features = { stickerPlacement: false, imageCardInfoButton: false, imageGeneration: false };
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
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
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

import { ImageCard } from './ImageCard';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { renderWithProviders, LOADABLE_IMAGE_DATA_URI } from '../../../test/component-setup';
import { cleanup } from 'vitest-browser-react';
import { MediaType } from '~/shared/utils/prisma/enums';

// The two column widths the featured/home grid lays out (HomeBlock.module.scss:
// 336px, and 296px in the three narrower rules).
const CARD_WIDTH = 336;
const NARROW_CARD_WIDTH = 296;
const WIDE_CARD_WIDTH = 400;

function imageData(counts: number, poi = false) {
  return {
    id: 1,
    url: LOADABLE_IMAGE_DATA_URI,
    type: MediaType.image,
    name: 'card.png',
    metadata: null,
    nsfwLevel: 1,
    width: 700,
    height: 900,
    hasMeta: true,
    poi,
    reactions: [],
    user: { id: 2, username: 'someone' },
    stats: {
      likeCountAllTime: counts,
      dislikeCountAllTime: 0,
      heartCountAllTime: counts,
      laughCountAllTime: counts,
      cryCountAllTime: counts,
      tippedAmountCountAllTime: counts,
    },
  } as any;
}

const onCardClick = vi.fn();

async function renderCard(counts: number, width: number = CARD_WIDTH, poi = false) {
  renderWithProviders(
    <IntersectionObserverProvider>
      <div data-testid="card-root" style={{ width }} onClick={onCardClick}>
        <ImageCard data={imageData(counts, poi)} />
      </div>
    </IntersectionObserverProvider>
  );
  await vi.waitFor(() => {
    expect(document.body.querySelectorAll('[aria-label$="reaction"]').length).toBeGreaterThan(0);
  });
}

function resizeCard(width: number) {
  (document.querySelector('[data-testid="card-root"]') as HTMLElement).style.width = `${width}px`;
}

function reactionBarOverflow() {
  const bar = document.body.querySelector('[aria-label$="reaction"]')!.parentElement!;
  const card = document.querySelector('[data-testid="card-root"]')!;
  return bar.getBoundingClientRect().right - card.getBoundingClientRect().right;
}

function reactionLabels() {
  return [...document.body.querySelectorAll('[aria-label$="reaction"]')].map(
    (b) => (b as HTMLElement).innerText
  );
}

function infoButtons() {
  return document.body.querySelectorAll('.tabler-icon-info-circle');
}

afterEach(() => {
  features.imageCardInfoButton = false;
  features.stickerPlacement = false;
  stickerBadge.renders = true;
});

describe('ImageCard info button', () => {
  test('is hidden while the flag is off, even when the image has metadata', async () => {
    await renderCard(1455);

    expect(infoButtons()).toHaveLength(0);
  });

  test('comes back when the flag is on', async () => {
    features.imageCardInfoButton = true;
    await renderCard(1455);

    expect(infoButtons()).toHaveLength(1);
  });
});

// Reported 2026-08-14 (ClickUp 868krjmvv): on the featured grid, reaction counts of four digits
// were clipped at the card edge (a count cropped to "1,16"). Counts are spelled out in full where
// there is room (a reader watching one tick up) and abbreviate on the narrow column.
describe('ImageCard action row at four-digit reaction counts', () => {
  // The reaction row takes the full narrow column and abbreviates its counts, so four- and
  // five-digit counts fit. The Buzz tip no longer shares that row (see the next describe).
  test('fits the narrow column at four- and five-digit counts, abbreviated', async () => {
    await renderCard(1455, NARROW_CARD_WIDTH);
    expect(reactionBarOverflow()).toBeLessThanOrEqual(0);
    expect(reactionLabels()).toEqual(Array(4).fill(expect.stringContaining('1.5K')));
    await cleanup();

    await renderCard(12345, NARROW_CARD_WIDTH);
    expect(reactionBarOverflow()).toBeLessThanOrEqual(0);
    expect(reactionLabels()).toEqual(Array(4).fill(expect.stringContaining('12.3K')));
  });

  // Counts are spelled out in full wherever there is room: a reader watching one tick up.
  test('keeps full counts on a wide card', async () => {
    await renderCard(1455, CARD_WIDTH);
    expect(reactionLabels()).toEqual(Array(4).fill(expect.stringContaining('1,455')));
    expect(reactionBarOverflow()).toBeLessThanOrEqual(0);
    await cleanup();

    await renderCard(12345, WIDE_CARD_WIDTH);
    expect(reactionLabels()).toEqual(Array(4).fill(expect.stringContaining('12,345')));
    expect(reactionBarOverflow()).toBeLessThanOrEqual(0);
  });

  // The form follows the row's own width, so the same card flips both ways. This is what fails
  // if the container query stops applying: the labels would stay in one form.
  test('the same card flips between abbreviated and full as its width changes', async () => {
    await renderCard(1455, NARROW_CARD_WIDTH);
    expect(reactionLabels()[0]).toContain('1.5K');

    resizeCard(WIDE_CARD_WIDTH);
    await vi.waitFor(() => expect(reactionLabels()[0]).toContain('1,455'));

    resizeCard(NARROW_CARD_WIDTH);
    await vi.waitFor(() => expect(reactionLabels()[0]).toContain('1.5K'));
  });

  // The width a count needs grows with its length, so the point where it abbreviates does too:
  // 123,456 does not fit a 365px card in full.
  test('six-digit counts abbreviate where they would clip in full', async () => {
    await renderCard(123456, 365);
    expect(reactionLabels()[0]).toContain('123.5K');
    expect(reactionBarOverflow()).toBeLessThanOrEqual(0);
    await cleanup();

    await renderCard(123456, 450);
    expect(reactionLabels()[0]).toContain('123,456');
    expect(reactionBarOverflow()).toBeLessThanOrEqual(0);
  });
});

// The Buzz tip is its own element in the action row, not part of the reaction bar. It always sits
// on the line under the reactions, beside the sticker badge, so cards in one grid line up.
describe('ImageCard Buzz tip placement', () => {
  const TIP_ROW_WIDTHS = [NARROW_CARD_WIDTH, 420];

  function rects() {
    const bolt = document.body.querySelector('.tabler-icon-bolt');
    const bar = document.body
      .querySelector('[aria-label$="reaction"]')!
      .parentElement!.getBoundingClientRect();
    const sticker = document.body
      .querySelector('[data-testid="sticker-badge"]')
      ?.getBoundingClientRect();
    const card = document.querySelector('[data-testid="card-root"]')!.getBoundingClientRect();
    return { tip: bolt?.getBoundingClientRect(), sticker, bar, card };
  }

  test.each(TIP_ROW_WIDTHS)(
    'is under the reactions at %ipx, whatever the count length',
    async (width) => {
      for (const counts of [7, 1455, 12345]) {
        await renderCard(counts, width);
        const { tip, bar } = rects();
        expect(tip!.top).toBeGreaterThanOrEqual(bar.bottom);
        expect(Math.abs(tip!.left - bar.left)).toBeLessThan(8);
        await cleanup();
      }
    }
  );

  test.each(TIP_ROW_WIDTHS)(
    'shares its line with the sticker badge and info button at %ipx',
    async (width) => {
      features.stickerPlacement = true;
      features.imageCardInfoButton = true;
      await renderCard(7, width);
      const { tip, sticker, bar } = rects();
      const info = infoButtons()[0].getBoundingClientRect();

      expect(tip!.top).toBeGreaterThanOrEqual(bar.bottom);
      expect(
        Math.abs(tip!.top + tip!.height / 2 - (sticker!.top + sticker!.height / 2))
      ).toBeLessThan(8);
      expect(Math.abs(info.top + info.height / 2 - (tip!.top + tip!.height / 2))).toBeLessThan(8);
      expect(sticker!.left).toBeGreaterThan(tip!.right);
    }
  );

  // Reported 2026-11-02: with a sticker badge on one card and not its neighbour, the reactions sat
  // at different heights across a grid row.
  test.each([NARROW_CARD_WIDTH, CARD_WIDTH, 380, 420])(
    'keeps the reactions the same distance from the card bottom with or without a sticker badge at %ipx',
    async (width) => {
      features.stickerPlacement = true;
      for (const counts of [7, 1455, 12345]) {
        stickerBadge.renders = true;
        await renderCard(counts, width);
        const withSticker = rects();
        expect(withSticker.sticker).toBeDefined();
        await cleanup();

        stickerBadge.renders = false;
        await renderCard(counts, width);
        const without = rects();
        expect(without.sticker).toBeUndefined();
        expect(without.card.bottom - without.bar.bottom).toBeCloseTo(
          withSticker.card.bottom - withSticker.bar.bottom,
          0
        );
        await cleanup();
      }
    }
  );

  // Content-sized and left-aligned where the counts fit in full; the whole row only where they
  // abbreviate, as before the tip moved.
  test('the reaction bar fills the row only where the counts abbreviate', async () => {
    await renderCard(7, 420);
    const wide = rects();
    expect(wide.bar.width).toBeLessThan(wide.card.width - 100);
    await cleanup();

    await renderCard(7, NARROW_CARD_WIDTH);
    const narrow = rects();
    expect(narrow.bar.width).toBeGreaterThan(narrow.card.width - 24);
  });

  test('a card with no tip, no stickers and no info button has no second line', async () => {
    features.stickerPlacement = true;
    stickerBadge.renders = false;
    await renderCard(7, NARROW_CARD_WIDTH, true);
    const tipRow = document.body.querySelector('[aria-label$="reaction"]')!.parentElement!
      .parentElement!.nextElementSibling as HTMLElement;
    const bar = document.body.querySelector('[aria-label$="reaction"]')!.parentElement!;
    const gapBelowBar = () =>
      document.querySelector('[data-testid="card-root"]')!.getBoundingClientRect().bottom -
      bar.getBoundingClientRect().bottom;
    const before = gapBelowBar();

    expect(document.body.querySelector('.tabler-icon-bolt')).toBeNull();
    expect(getComputedStyle(tipRow).display).toBe('none');
    expect(tipRow.getBoundingClientRect().height).toBe(0);
    tipRow.remove();
    expect(gapBelowBar()).toBe(before);
  });

  test('a card with only the info button keeps it on the second line', async () => {
    features.imageCardInfoButton = true;
    stickerBadge.renders = false;
    await renderCard(7, NARROW_CARD_WIDTH, true);
    const { bar, card } = rects();
    const info = infoButtons()[0].getBoundingClientRect();

    expect(info.top).toBeGreaterThanOrEqual(bar.bottom);
    expect(info.right).toBeLessThanOrEqual(card.right);
  });

  test('a card with only a sticker badge keeps the badge on the second line', async () => {
    features.stickerPlacement = true;
    await renderCard(7, NARROW_CARD_WIDTH, true);
    const { sticker, bar, card } = rects();

    expect(sticker!.top).toBeGreaterThanOrEqual(bar.bottom);
    expect(sticker!.right).toBeLessThanOrEqual(card.right);
  });

  // Outside the reaction bar the tip lost the bar's click guard; without its own, a tap on the
  // tip would open the image instead of tipping.
  test('a tap on the tip does not reach the card', async () => {
    await renderCard(1455, NARROW_CARD_WIDTH);
    onCardClick.mockClear();

    (document.body.querySelector('.tabler-icon-bolt') as SVGElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );

    expect(onCardClick).not.toHaveBeenCalled();
  });
});
