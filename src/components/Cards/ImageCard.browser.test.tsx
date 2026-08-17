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
import { MediaType } from '~/shared/utils/prisma/enums';

// The widest column the featured/home grid lays out (HomeBlock.module.scss).
const CARD_WIDTH = 336;
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
      tippedAmountCountAllTime: 0,
    },
  } as any;
}

async function renderCard(counts: number) {
  renderWithProviders(
    <IntersectionObserverProvider>
      <div style={{ width: CARD_WIDTH }}>
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

  test('fits on one line at three-digit counts either way', async () => {
    features.imageCardInfoButton = true;
    await renderCard(145);

    expect(actionRowHeight()).toBeLessThan(SINGLE_ROW_MAX_HEIGHT);
  });
});
