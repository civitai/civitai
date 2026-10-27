import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsModule from '~/providers/BrowserSettingsProvider';
import type * as BrowsingLevelModule from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as UserHoverCardModule from '~/components/UserAvatar/UserHoverCard';

// The pill's backing lives in Cards.module.css, so a computed style only means something with the
// real stylesheets loaded (see ImageCard.browser.test.tsx for why Tailwind needs importing).
import '@mantine/core/styles.css';
import '~/styles/globals.css';

const features = { stickerPlacement: false, imageCardInfoButton: false, imageGeneration: false };

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
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelModule>()),
  useViewerBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/UserAvatar/UserHoverCard', async (importOriginal) => ({
  ...(await importOriginal<typeof UserHoverCardModule>()),
  UserHoverCard: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('~/components/Image/Providers/ImagesProvider', () => ({
  useImagesContext: () => ({ getImages: () => [] }),
}));
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', () => ({
  ImageContextMenu: () => null,
}));
vi.mock('~/components/Image/Remix/CardRemixButton', () => ({ CardRemixButton: () => null }));
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
import { contrastOnBlack } from '~/utils/contrast-floor';

const plate = (from: string, to: string) => ({
  cosmetic: { type: 'NamePlate', data: { variant: 'gradient', gradient: { from, to, deg: 90 } } },
  data: null,
});
// Supernova, whose dark stop is 3.33:1 on black unlifted.
const nameplate = plate('#e58cff', '#7b2fe0');
const HARD_BLACK_EDGE = /rgb\(0, 0, 0\) 1px 0px 0px.*rgb\(0, 0, 0\) -1px 0px 0px/;

function imageData(cosmetics: unknown[]) {
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
    user: { id: 2, username: 'someone', profilePicture: null, cosmetics },
    stats: {
      likeCountAllTime: 1,
      dislikeCountAllTime: 0,
      heartCountAllTime: 0,
      laughCountAllTime: 0,
      cryCountAllTime: 0,
      tippedAmountCountAllTime: 0,
    },
  } as any;
}

async function renderPill(cosmetics: unknown[]) {
  renderWithProviders(
    <IntersectionObserverProvider>
      <div style={{ width: 336 }}>
        <ImageCard data={imageData(cosmetics)} />
      </div>
    </IntersectionObserverProvider>
  );
  await vi.waitFor(() => {
    expect(document.body.querySelector('[class*="creatorPill"]')).not.toBeNull();
  });
  const pill = document.body.querySelector('[class*="creatorPill"]')!;
  const nameEl = pill.firstElementChild!;
  const gradient = getComputedStyle(nameEl).getPropertyValue('--text-gradient');
  const stops = [...gradient.matchAll(/#([0-9a-f]{6})/gi)].map(([, hex]) =>
    [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  );
  return { pill: getComputedStyle(pill), name: getComputedStyle(nameEl), stops };
}

describe('ImageCard creator pill', () => {
  test('keeps the shared translucent backing and no edge for a default name', async () => {
    const { pill, name } = await renderPill([]);
    expect(pill.backgroundColor).toBe('rgba(0, 0, 0, 0.31)');
    expect(name.filter).not.toMatch(HARD_BLACK_EDGE);
    expect(name.color).toBe('rgb(255, 255, 255)');
  });

  test('keeps that backing behind a cosmetic nameplate and edges the name in black', async () => {
    const { pill, name } = await renderPill([nameplate]);
    expect(pill.backgroundColor).toBe('rgba(0, 0, 0, 0.31)');
    expect(name.filter).toMatch(HARD_BLACK_EDGE);
  });

  test.each([
    ['Supernova', '#e58cff', '#7b2fe0'],
    ['Champion 2', '#07d1d3', '#b10ce0'],
    ['Champion 5', '#00f2f4', '#b142ff'],
    ['Moderator', '#b31a1a', '#de2222'],
  ])('every %s stop meets 4.5:1 against the black edge', async (_, from, to) => {
    const { stops } = await renderPill([plate(from, to)]);
    expect(stops.length).toBeGreaterThanOrEqual(2);
    for (const stop of stops) expect(contrastOnBlack(stop)).toBeGreaterThanOrEqual(4.5);
  });

  test("the dark scheme does not swap the nameplate glow for the name's default shadow", async () => {
    document.documentElement.setAttribute('data-mantine-color-scheme', 'dark');
    try {
      const { name } = await renderPill([nameplate]);
      expect(name.filter).toMatch(HARD_BLACK_EDGE);
    } finally {
      document.documentElement.removeAttribute('data-mantine-color-scheme');
    }
  });
});
