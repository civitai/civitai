import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as RoutedDialogLinkModule from '~/components/Dialog/RoutedDialogLink';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as Trpc from '~/utils/trpc';

const features = vi.hoisted(() => ({
  music: true as boolean | undefined,
  stickerPlacement: false,
  imageCardInfoButton: false,
  imageGeneration: false,
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => features,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  const { makeTrpcProxy } = await import('../../../../../test/trpcProxyStub');
  const { withSongCoversStub } = await import(
    '../../../MusicPlayer/__tests__/song-covers-trpc-stub'
  );
  return { ...actual, trpc: withSongCoversStub(makeTrpcProxy() as typeof actual.trpc) };
});
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, isModerator: false, muted: false, filePreferences: {} }),
}));
vi.mock('~/components/Image/Providers/ImagesProvider', () => ({
  useImagesContext: () => ({ getImages: () => [] }),
}));
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', () => ({
  ImageContextMenu: () => null,
}));
vi.mock('~/components/Image/Remix/RemixMenu', () => ({
  RemixMenu: () => null,
  isRemixMenuVisible: () => false,
}));
vi.mock('~/components/RemixGallery/use-remix-card-data', () => ({
  useRemixCardData: () => ({ any: false }),
}));
vi.mock('~/components/RemixGallery/RemixedCardFlyout', () => ({ RemixedCardFlyout: () => null }));
vi.mock('~/components/Tours/ToursProvider', () => ({
  useTourContext: () => ({ running: false, helpers: null }),
}));
vi.mock('~/components/Storyline/StorylineBatchProvider', () => ({
  useStorylineForPost: () => undefined,
}));
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<typeof RoutedDialogLinkModule>()),
  RoutedDialogLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  triggerRoutedDialog: () => undefined,
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  EdgeMedia2: () => <div data-testid="edge-media" />,
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
vi.mock('~/components/Metrics/useMetricSubscription', () => ({
  useMetricSubscription: () => undefined,
}));
vi.mock('~/components/Buzz/InteractiveTipBuzzButton', () => ({
  InteractiveTipBuzzButton: ({ children }: { children: ReactNode }) => <>{children}</>,
  useBuzzTippingStore: () => 0,
}));

import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { ImagesCard } from '~/components/Image/Infinite/ImagesCard';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { MediaType } from '~/shared/utils/prisma/enums';
import { renderWithProviders } from '../../../../../test/component-setup';

const audioItem = {
  id: 7,
  url: 'song.mp3',
  type: MediaType.audio,
  name: null,
  metadata: { title: 'Neon Rain', duration: 214, genre: 'Synthwave' },
  nsfwLevel: 1,
  width: null,
  height: null,
  hasMeta: false,
  poi: false,
  publishedAt: new Date('2026-11-01'),
  reactions: [],
  tags: [],
  user: { id: 2, username: 'beatsmith' },
  stats: { likeCountAllTime: 12, commentCountAllTime: 4 },
} as unknown as ImagesInfiniteModel;

const render = () =>
  renderWithProviders(
    <IntersectionObserverProvider>
      <div style={{ width: 300 }}>
        <ImagesCard data={audioItem} height={380} />
      </div>
    </IntersectionObserverProvider>
  );

describe('an audio item in an image feed', () => {
  test('renders as the Song Card, with its title, creator and length', async () => {
    features.music = true;
    await render();
    await expect.element(page.getByRole('button', { name: 'Play Neon Rain' })).toBeInTheDocument();
    await expect.element(page.getByText('Neon Rain')).toBeInTheDocument();
    await expect.element(page.getByRole('link', { name: 'beatsmith' })).toBeInTheDocument();
    await expect.element(page.getByText('3:34')).toBeInTheDocument();
  });

  test('with the music flag off, stays the plain media card', async () => {
    features.music = undefined;
    await render();
    await expect.element(page.getByTestId('edge-media')).toBeInTheDocument();
    expect(page.getByRole('button', { name: 'Play Neon Rain' }).query()).toBeNull();
  });
});
