import type * as CardStickerOverlayModule from '~/components/Sticker/CardStickerOverlay';
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
vi.mock('~/components/Sticker/CardStickerOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof CardStickerOverlayModule>()),
  CardStickerOverlay: () => null,
}));
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

function imageData(counts: number, poi = false, framed = false) {
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
    cosmetic: framed
      ? { data: { cssFrame: 'linear-gradient(135deg, #f5d36b, #b8860b)' } }
      : undefined,
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
// were clipped at the card edge (a count cropped to "1,16").
describe('ImageCard action row counts', () => {
  test.each([NARROW_CARD_WIDTH, CARD_WIDTH, 420, 450])(
    'abbreviates every count and fits the card at %ipx',
    async (width) => {
      await renderCard(1455, width);
      expect(reactionBarOverflow()).toBeLessThanOrEqual(0);
      expect(reactionLabels()).toEqual(Array(4).fill(expect.stringContaining('1.5K')));
    }
  );

  test.each([NARROW_CARD_WIDTH, 420, 450])(
    'abbreviates six-digit counts and fits at %ipx',
    async (width) => {
      await renderCard(123456, width);
      expect(reactionBarOverflow()).toBeLessThanOrEqual(0);
      expect(reactionLabels()).toEqual(Array(4).fill(expect.stringContaining('123.5K')));
    }
  );
});

// Reported 2026-11-02 (hq:image_cards_reaction_58hs): a gold-framed card showed "1K" in a bar
// spanning the row while the unframed card beside it showed "1,082" in a content-width bar. The
// frame's padding narrows the footer, and the old per-row container query picked the count form
// and the bar width from that width. Two cards with the same counts must lay out the same.
describe('ImageCard cosmetic frame', () => {
  test.each([NARROW_CARD_WIDTH, 320, CARD_WIDTH, 358, 420])(
    'framed and unframed cards show the same counts in a content-width bar at %ipx',
    async (width) => {
      renderWithProviders(
        <IntersectionObserverProvider>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width }}>
            {[false, true].map((framed) => (
              <div key={String(framed)} data-testid={framed ? 'framed' : 'plain'} style={{ width }}>
                <ImageCard data={imageData(1082, false, framed)} />
              </div>
            ))}
          </div>
        </IntersectionObserverProvider>
      );
      await vi.waitFor(() => {
        expect(document.body.querySelectorAll('[aria-label$="reaction"]')).toHaveLength(8);
      });
      const measure = (id: string) => {
        const root = document.querySelector(`[data-testid="${id}"]`)!;
        const buttons = [...root.querySelectorAll('[aria-label$="reaction"]')];
        const bar = buttons[0].parentElement!;
        const natural = buttons.reduce((sum, b) => sum + b.getBoundingClientRect().width, 0);
        return {
          labels: buttons.map((b) => (b as HTMLElement).innerText.split('\n').filter(Boolean)[1]),
          // How far the frame pushes the footer in from the card's edge.
          inset: buttons[0].getBoundingClientRect().left - root.getBoundingClientRect().left,
          // Slack of one 2px gap per button; a bar stretched across the row is far past it.
          stretch: bar.getBoundingClientRect().width - natural - 2 * buttons.length,
        };
      };
      const plain = measure('plain');
      const framed = measure('framed');
      expect(plain.labels).toEqual(Array(4).fill('1.1K'));
      expect(framed.labels).toEqual(plain.labels);
      expect(plain.stretch).toBeLessThanOrEqual(0);
      expect(framed.stretch).toBeLessThanOrEqual(0);
      // Control: the frame really narrows the footer here, so the equal results above are earned.
      expect(framed.inset).toBeGreaterThan(plain.inset);
    }
  );
});

// The Buzz tip is its own element in the action row, not part of the reaction bar. It sits under
// the reactions on a narrow card and beside them on a wide one.
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

  test.each([7, 1455, 12345])(
    'is under the reactions on a narrow card, counts %i',
    async (counts) => {
      await renderCard(counts, NARROW_CARD_WIDTH);
      const { tip, bar } = rects();
      expect(tip!.top).toBeGreaterThanOrEqual(bar.bottom);
      expect(Math.abs(tip!.left - bar.left)).toBeLessThan(8);
    }
  );

  test.each([7, 342])('is beside the reactions on a 420px card, counts %i', async (counts) => {
    features.stickerPlacement = true;
    features.imageCardInfoButton = true;
    await renderCard(counts, 420);
    const { tip, bar, sticker, card } = rects();
    const info = infoButtons()[0].getBoundingClientRect();
    const mid = (r: DOMRect) => r.top + r.height / 2;

    expect(tip!.left).toBeGreaterThanOrEqual(bar.right - 1);
    expect(Math.abs(mid(tip!) - (bar.top + bar.height / 2))).toBeLessThan(4);
    expect(Math.abs(mid(sticker!) - mid(tip!))).toBeLessThan(4);
    expect(Math.abs(mid(info) - mid(tip!))).toBeLessThan(4);
    expect(info.right).toBeLessThanOrEqual(card.right);
  });

  // Five-digit counts fill the line, so the badges wrap under the bar.
  test('wraps the badges under the reactions when five-digit counts fill the line', async () => {
    features.stickerPlacement = true;
    await renderCard(12345, 420);
    const { bar, sticker, card } = rects();
    expect(sticker!.top).toBeGreaterThanOrEqual(bar.bottom);
    expect(sticker!.right).toBeLessThanOrEqual(card.right);
  });

  test('footer controls are compact: 22px bars, one line at 420px, two on a narrow card', async () => {
    await renderCard(1455, 420);
    const wide = rects();
    expect(wide.bar.height).toBe(22);
    expect(
      Math.abs(wide.tip!.top + wide.tip!.height / 2 - (wide.bar.top + wide.bar.height / 2))
    ).toBeLessThan(4);
    await cleanup();

    await renderCard(1455, NARROW_CARD_WIDTH);
    const narrow = rects();
    expect(narrow.bar.height).toBe(22);
    expect(narrow.tip!.top).toBeGreaterThanOrEqual(narrow.bar.bottom);
  });

  test.each(TIP_ROW_WIDTHS)(
    'shares its line with the sticker badge and info button at %ipx',
    async (width) => {
      features.stickerPlacement = true;
      features.imageCardInfoButton = true;
      await renderCard(7, width);
      const { tip, sticker } = rects();
      const info = infoButtons()[0].getBoundingClientRect();

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
      // At 420px five-digit counts wrap the badge to its own line, which moves the bar.
      for (const counts of width === 420 ? [7, 1455] : [7, 1455, 12345]) {
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

  test('the reaction bar is content-width, not the whole row', async () => {
    await renderCard(7, NARROW_CARD_WIDTH);
    const narrow = rects();
    expect(narrow.bar.width).toBeLessThan(narrow.card.width - 100);
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
