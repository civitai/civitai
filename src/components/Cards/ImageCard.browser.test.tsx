import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';

// The component project loads no global stylesheet, so Tailwind — including
// preflight's `box-sizing: border-box` — is inert unless a test imports it.
// Without this the card's footer measures 16px WIDER than the card and every
// utility class in the footer row is dead, which is a different layout from the
// one that ships. The wrap assertion below is only meaningful with it.
import '~/styles/globals.css';

const features = { stickerPlacement: false, imageCardInfoButton: false, imageGeneration: false };

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => features,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: { reaction: { toggle: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } } },
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, isModerator: false, muted: false, filePreferences: {} }),
}));
vi.mock('~/providers/BrowserSettingsProvider', () => ({
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
const SINGLE_ROW_MAX_HEIGHT = 40;

// How far the reaction bar may stick out past the narrow card before we call it a
// regression. `reactionBarOverflow()` is a raw pixel distance driven by the WIDTH
// OF RENDERED TEXT, so unlike the height assertions above it moves with font
// metrics and therefore with the environment:
//
//   50px  the value this test shipped with (#4034) — measured off-CI
//   57px  the CI browser, measured 2026-08-17 on two independent runs
//
// It shipped red for that reason: `preview / component-tests` is report-only, and
// no component-tests status was ever posted on #4034, so nothing said so.
//
// The bound sits above the largest observed value rather than ON it, because the
// regression this guards against — an extra control in the row, an un-hidden info
// button, a wider count format — moves this number by TENS of px, while a browser
// or font-stack change moves it by a few. Pinning it tight would buy no sensitivity
// and would re-red the suite on an unrelated chromium bump.
const MAX_NARROW_OVERFLOW_PX = 64;

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
      tippedAmountCountAllTime: 0,
    },
  } as any;
}

async function renderCard(counts: number, width: number = CARD_WIDTH) {
  renderWithProviders(
    <IntersectionObserverProvider>
      <div style={{ width }}>
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

function infoButtons() {
  return document.body.querySelectorAll('.tabler-icon-info-circle');
}

afterEach(() => {
  features.imageCardInfoButton = false;
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

// Reported 2026-08-14 (ClickUp 868krjmvv): on the featured grid, cards whose
// reaction counts reach four digits pushed the info button onto a second line
// and clipped the last reaction at the card edge. Counts are deliberately NOT
// abbreviated on this card — a reader watching a count tick up by one is the
// point — so the room has to come from somewhere else.
describe('ImageCard action row at four-digit reaction counts', () => {
  test('stays on one line with the info button hidden', async () => {
    await renderCard(1455);

    expect(actionRowHeight()).toBeLessThan(SINGLE_ROW_MAX_HEIGHT);
  });

  test('wraps to a second line with the info button shown', async () => {
    features.imageCardInfoButton = true;
    await renderCard(1455);

    expect(actionRowHeight()).toBeGreaterThan(SINGLE_ROW_MAX_HEIGHT);
  });

  // Hiding the button buys back a line, not width: at the narrow column the bar
  // itself is wider than the card and the last reaction is still clipped. That
  // half of 868krjmvv is NOT fixed, so this pins the overflow at its current
  // size rather than pretending it is gone — it fails if a change makes it
  // worse, and passes if someone finally closes it.
  test('still overruns the narrow column, by no more than it does today', async () => {
    await renderCard(1455, NARROW_CARD_WIDTH);
    const fourDigits = reactionBarOverflow();
    await cleanup();

    // Three-digit counts fit with room to spare, so a negative number here is
    // what proves the measurement above tracks the bar and not some constant.
    await renderCard(145, NARROW_CARD_WIDTH);
    const threeDigits = reactionBarOverflow();

    expect(threeDigits).toBeLessThan(0);
    expect(fourDigits).toBeLessThanOrEqual(MAX_NARROW_OVERFLOW_PX);
  });

  test('fits on one line at three-digit counts either way', async () => {
    features.imageCardInfoButton = true;
    await renderCard(145);

    expect(actionRowHeight()).toBeLessThan(SINGLE_ROW_MAX_HEIGHT);
  });
});
