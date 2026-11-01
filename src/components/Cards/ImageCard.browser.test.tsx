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
  StickerPlacementCardBadge: () => <button data-testid="sticker-badge">stickers</button>,
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
// Wide enough for the reactions and the Buzz tip to share a row at four-digit counts.
const WIDE_CARD_WIDTH = 400;
const SINGLE_ROW_MAX_HEIGHT = 40;

function imageData(counts: number) {
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

async function renderCard(counts: number, width: number = CARD_WIDTH) {
  renderWithProviders(
    <IntersectionObserverProvider>
      <div style={{ width }} onClick={onCardClick}>
        <ImageCard data={imageData(counts)} />
      </div>
    </IntersectionObserverProvider>
  );
  await vi.waitFor(() => {
    expect(document.body.querySelectorAll('[aria-label$="reaction"]').length).toBeGreaterThan(0);
  });
}

function actionRowHeight() {
  const bar = document.body.querySelector('[aria-label$="reaction"]')!.parentElement!;
  return bar.parentElement!.getBoundingClientRect().height;
}

function reactionBarOverflow() {
  const bar = document.body.querySelector('[aria-label$="reaction"]')!.parentElement!;
  const card = bar.parentElement!.parentElement!.parentElement!;
  return bar.getBoundingClientRect().right - card.getBoundingClientRect().right;
}

function reactionLabels() {
  return [...document.body.querySelectorAll('[aria-label$="reaction"]')].map(
    (b) => b.textContent ?? ''
  );
}

function infoButtons() {
  return document.body.querySelectorAll('.tabler-icon-info-circle');
}

afterEach(() => {
  features.imageCardInfoButton = false;
  features.stickerPlacement = false;
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
});

// The Buzz tip is its own element in the action row, not part of the reaction bar, so on a narrow
// card it wraps to the line under the reactions, beside the sticker badge.
describe('ImageCard Buzz tip placement', () => {
  function tipAndSticker() {
    const tip = document.body.querySelector('.tabler-icon-bolt')!.getBoundingClientRect();
    const sticker = document.body
      .querySelector('[data-testid="sticker-badge"]')!
      .getBoundingClientRect();
    const bar = document.body
      .querySelector('[aria-label$="reaction"]')!
      .parentElement!.getBoundingClientRect();
    return { tip, sticker, bar };
  }

  test('wraps under the reactions, on the sticker badge line, on a narrow card', async () => {
    features.stickerPlacement = true;
    features.imageCardInfoButton = true;
    await renderCard(1455, NARROW_CARD_WIDTH);
    const { tip, sticker, bar } = tipAndSticker();
    const info = infoButtons()[0].getBoundingClientRect();
    expect(Math.abs(info.top + info.height / 2 - (tip.top + tip.height / 2))).toBeLessThan(8);

    expect(tip.top).toBeGreaterThanOrEqual(bar.bottom);
    expect(Math.abs(tip.top + tip.height / 2 - (sticker.top + sticker.height / 2))).toBeLessThan(8);
    expect(sticker.left).toBeGreaterThan(tip.right);
  });

  test('wraps under the reactions at small counts too, so the layout does not jump between cards', async () => {
    await renderCard(7, NARROW_CARD_WIDTH);
    const tip = document.body.querySelector('.tabler-icon-bolt')!.getBoundingClientRect();
    const bar = document.body
      .querySelector('[aria-label$="reaction"]')!
      .parentElement!.getBoundingClientRect();

    expect(tip.top).toBeGreaterThanOrEqual(bar.bottom);
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

  test('sits beside the reactions on a card wide enough for both', async () => {
    await renderCard(1455, WIDE_CARD_WIDTH);
    const tip = document.body.querySelector('.tabler-icon-bolt')!.getBoundingClientRect();
    const bar = document.body
      .querySelector('[aria-label$="reaction"]')!
      .parentElement!.getBoundingClientRect();

    expect(actionRowHeight()).toBeLessThan(SINGLE_ROW_MAX_HEIGHT);
    expect(tip.left).toBeGreaterThanOrEqual(bar.right);
  });
});
