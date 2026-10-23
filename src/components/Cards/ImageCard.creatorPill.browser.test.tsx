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

const nameplate = {
  cosmetic: {
    type: 'NamePlate',
    data: { variant: 'gradient', gradient: { from: '#e58cff', to: '#7b2fe0', deg: 90 } },
  },
  data: null,
};

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

async function pillBackground(cosmetics: unknown[]) {
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
  return getComputedStyle(document.body.querySelector('[class*="creatorPill"]')!).backgroundColor;
}

describe('ImageCard creator pill backing', () => {
  test('keeps the shared translucent backing for a default name', async () => {
    expect(await pillBackground([])).toBe('rgba(0, 0, 0, 0.31)');
  });

  test('goes near-opaque behind a cosmetic nameplate', async () => {
    expect(await pillBackground([nameplate])).toBe('rgba(0, 0, 0, 0.9)');
  });
});
