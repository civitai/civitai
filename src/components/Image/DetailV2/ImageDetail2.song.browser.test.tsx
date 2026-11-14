import type { ReactNode } from 'react';
import { DEFAULT_THEME, MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import type * as TrpcModule from '~/utils/trpc';
import type * as ImageDetailProviderModule from '~/components/Image/Detail/ImageDetailProvider';
import type * as HatTurfDetailControlsModule from '~/components/HatTurf/detail/HatTurfDetailControls';
import type * as HatTurfDetailProviderModule from '~/components/HatTurf/detail/HatTurfDetailProvider';

import '../../../../test/component-setup';

/**
 * A song in the real `ImageDetail2`, its children probes (the mock set of
 * `ImageDetail2.clientOnlySections.browser.test.tsx`): with the `music` flag, the cover-tinted stage,
 * Up next and the More-from card join the existing action row, whose Remix follows the song's own
 * `allowRemix`; without it the page is today's image page.
 */

const song = (metadata: Record<string, unknown>) => ({
  id: 1,
  url: 'song-1.mp3',
  nsfwLevel: 1,
  width: null,
  height: null,
  type: 'audio',
  name: null,
  postId: 5,
  poi: false,
  minor: false,
  hasMeta: true,
  metadata: { title: 'Midnight Arcade', duration: 178, ...metadata },
  tagIds: [],
  publishedAt: new Date('2026-11-01'),
  user: { id: 2, username: 'neonwave' },
  stats: {},
});

const state = vi.hoisted(() => ({ music: true, show: true, image: null as unknown }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy(),
}));
vi.mock('~/components/Image/Detail/ImageDetailProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageDetailProviderModule>()),
  useImageDetailContext: () => ({
    images: [state.image],
    index: 0,
    active: false,
    close: () => undefined,
    toggleInfo: () => undefined,
    shareUrl: '/images/1',
    navigate: () => undefined,
    loadMore: () => undefined,
    hasMore: false,
    collection: undefined,
    hideReactions: false,
  }),
}));
vi.mock('~/components/HatTurf/detail/HatTurfDetailProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof HatTurfDetailProviderModule>()),
  takesHats: () => false,
  HatTurfDetailProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  HatTurfDetailReset: () => null,
}));
vi.mock('~/components/HatTurf/detail/HatTurfDetailControls', async (importOriginal) => ({
  ...(await importOriginal<typeof HatTurfDetailControlsModule>()),
  HatTurfDetailControls: () => null,
  HatTurfDetailBadge: () => null,
}));
vi.mock('~/hooks/useCurrentUser', async (o) => ({
  ...(await o<object>()),
  useCurrentUser: () => null,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (o) => ({
  ...(await o<object>()),
  useFeatureFlags: () => ({ music: state.music }),
}));
vi.mock('~/providers/BrowserSettingsProvider', async (o) => ({
  ...(await o<object>()),
  useBrowsingSettings: <T,>(select: (state: Record<string, unknown>) => T) =>
    select({ browsingLevel: 1, blurNsfw: true, showNsfw: false, autoplayGifs: false }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (o) => ({
  ...(await o<object>()),
  BrowsingLevelProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', async (o) => ({
  ...(await o<object>()),
  BrowsingSettingsAddonsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
const stub = vi.hoisted(() => () => null);
vi.mock('~/components/Storyline/StorylineDetail', async (o) => ({
  ...(await o<object>()),
  StorylineStageOverlay: stub,
  StorylineToolbarChip: stub,
  StorylineChapterDescription: stub,
}));
vi.mock('~/components/Storyline/StorylineChapterRail', async (o) => ({
  ...(await o<object>()),
  StorylineChapterRail: stub,
}));
vi.mock('~/components/Ads/AdhesiveAd', async (o) => ({ ...(await o<object>()), AdhesiveAd: stub }));
vi.mock('~/components/Ads/AdUnit', async (o) => ({
  ...(await o<object>()),
  AdUnitSide_2: () => <div data-testid="ad-side" />,
  AdUnitSide_3: stub,
}));
vi.mock('~/components/Ads/AdUnitOutstream', async (o) => ({
  ...(await o<object>()),
  AdUnitOutstream: stub,
}));
vi.mock('~/components/Buzz/InteractiveTipBuzzButton', async (o) => ({
  ...(await o<object>()),
  InteractiveTipBuzzButton: stub,
}));
vi.mock('~/components/Carousel/CarouselIndicators', async (o) => ({
  ...(await o<object>()),
  CarouselIndicators: stub,
}));
vi.mock('~/components/Image/DetailV2/OwnerBlockedImageNotice', async (o) => ({
  ...(await o<object>()),
  OwnerBlockedImageNotice: stub,
}));
vi.mock('~/components/EntityCollaborator/EntityCollaboratorList', async (o) => ({
  ...(await o<object>()),
  EntityCollaboratorList: stub,
}));
vi.mock('~/components/Model3D/Posting/PostingToModel3DCard', async (o) => ({
  ...(await o<object>()),
  PostingToModel3DCard: stub,
}));
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', async (o) => ({
  ...(await o<object>()),
  ImageContextMenu: stub,
}));
vi.mock('~/components/Image/DetailV2/ImagePublishedWithApp', async (o) => ({
  ...(await o<object>()),
  ImagePublishedWithApp: stub,
}));
vi.mock('~/components/Image/DownloadImage', async (o) => ({
  ...(await o<object>()),
  DownloadImage: ({
    children,
  }: {
    children: (a: { onClick: () => void; isLoading: boolean; progress: number }) => ReactNode;
  }) => <>{children({ onClick: () => undefined, isLoading: false, progress: 0 })}</>,
}));
vi.mock('~/components/Metrics', async (o) => ({
  ...(await o<object>()),
  Metrics: () => <div data-testid="reactions" />,
}));
vi.mock('~/components/Reaction/ImageReactorsPreview', async (o) => ({
  ...(await o<object>()),
  ImageReactorsPreview: stub,
}));
vi.mock('~/components/ShareButton/ShareButton', async (o) => ({
  ...(await o<object>()),
  ShareButton: ({ children }: { children: ReactNode }) => (
    <div data-testid="share-button">{children}</div>
  ),
}));
vi.mock('~/components/Image/Remix/RemixMenu', async (o) => ({
  ...(await o<object>()),
  RemixMenu: ({ children }: { children: ReactNode }) => (
    <div data-testid="remix-menu">{children}</div>
  ),
}));
vi.mock('~/components/LoginRedirect/LoginRedirect', async (o) => ({
  ...(await o<object>()),
  LoginRedirect: stub,
}));
vi.mock('~/components/Gated/Gated', () => ({
  Gated: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('~/components/ImageGuard/ImageGuard2', async (o) => {
  function ImageGuard2({ children }: { children: (safe: boolean) => ReactNode }) {
    return <>{children(state.show)}</>;
  }
  ImageGuard2.BlurToggle = function BlurToggle() {
    return null;
  };
  return { ...(await o<object>()), ImageGuard2 };
});
vi.mock('~/components/Image/DetailV2/ImageDetailCarousel', () => ({
  ImageDetailCarousel: () => <div data-testid="carousel" />,
}));
vi.mock('~/components/Reaction/Reactions', async (o) => ({
  ...(await o<object>()),
  Reactions: stub,
}));
vi.mock('~/components/TrackView/TrackView', () => ({ TrackView: () => null }));
vi.mock('~/components/Sticker/StickerPlacementBar', () => ({ StickerPlacementBar: () => null }));
vi.mock('~/components/CreatorCard/CreatorCard', async (o) => ({
  ...(await o<object>()),
  SmartCreatorCard: () => <div data-testid="creator-card" />,
}));
// The tail, as probes.
vi.mock('~/components/Image/DetailV2/ImageDetailPostCard', async (o) => ({
  ...(await o<object>()),
  ImageDetailPostCard: () => <div data-testid="post-card" />,
}));
vi.mock('~/components/VotableTags/VotableTags', async (o) => ({
  ...(await o<object>()),
  VotableTags: () => <div data-testid="votable-tags" />,
}));
vi.mock('~/components/Image/DetailV2/ImageProcess', async (o) => ({
  ...(await o<object>()),
  ImageProcess: () => <div data-testid="image-process" />,
}));
vi.mock('~/components/Image/DetailV2/ImageRemixOfDetails', async (o) => ({
  ...(await o<object>()),
  ImageRemixOfDetails: () => <div data-testid="image-remix-of" />,
}));
vi.mock('~/components/RemixGallery/RemixGalleryCard', async (o) => ({
  ...(await o<object>()),
  RemixGalleryCard: () => <div data-testid="remix-gallery" />,
}));
vi.mock('~/components/Image/DetailV2/ImageGenerationData', async (o) => ({
  ...(await o<object>()),
  ImageGenerationData: () => <div data-testid="generation-data" />,
}));
vi.mock('~/components/Image/Detail/ImageDetailComments', () => ({
  ImageDetailComments: () => <div data-testid="image-comments" />,
}));
vi.mock('~/components/Image/DetailV2/ImageContestCollectionDetails', async (o) => ({
  ...(await o<object>()),
  useImageContestCollectionDetails: () => ({ collectionItems: [], post: undefined }),
  ImageContestCollectionDetails: () => <div data-testid="contest-details" />,
}));
vi.mock('~/components/Image/DetailV2/ImageExternalMeta', async (o) => ({
  ...(await o<object>()),
  ImageExternalMeta: () => <div data-testid="external-meta" />,
}));
// The Discussion card's body is the comments probe; the card itself must be open to render it.
vi.mock('~/components/Image/DetailV2/CollapsibleCard', async (o) => ({
  ...(await o<object>()),
  CollapsibleCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('~/components/Music/SongDetail/SongStageBackdrop', () => ({
  SongStageBackdrop: () => <div data-testid="song-backdrop" />,
}));
vi.mock('~/components/Music/SongDetail/SongUpNextButton', () => ({
  SongUpNextButton: () => <div data-testid="song-up-next" />,
}));
vi.mock('~/components/Music/SongDetail/SongMoreFromCard', () => ({
  SongMoreFromCard: () => <div data-testid="song-more-from" />,
}));

const { ImageDetail2 } = await import('~/components/Image/DetailV2/ImageDetail2');
const { ClientOnlySectionsProvider } = await import(
  '~/components/ClientOnlySection/ClientOnlySection'
);
const { ContainerProvider } = await import('~/components/ContainerProvider/ContainerProvider');

function renderDetail() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider theme={{ colors: { accent: DEFAULT_THEME.colors.orange } }}>
        <div style={{ width: 1280, height: 900 }}>
          <ContainerProvider containerName="main">
            <ClientOnlySectionsProvider enabled={false}>
              <ImageDetail2 />
            </ClientOnlySectionsProvider>
          </ContainerProvider>
        </div>
      </MantineProvider>
    </QueryClientProvider>
  );
}

beforeEach(async () => {
  await page.viewport(1440, 900);
  state.music = true;
  state.show = true;
  state.image = song({});
});

describe('a song in the image detail view', () => {
  test('keeps the action row: reactions, save, share and remix, beside Up next and the More-from card', async () => {
    await renderDetail();
    await expect.element(page.getByTestId('song-backdrop')).toBeInTheDocument();
    await expect.element(page.getByTestId('song-up-next')).toBeInTheDocument();
    await expect.element(page.getByTestId('song-more-from')).toBeInTheDocument();
    await expect.element(page.getByTestId('reactions')).toBeInTheDocument();
    await expect.element(page.getByTestId('share-button').first()).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Save' }).first()).toBeInTheDocument();
    await expect.element(page.getByTestId('remix-menu').first()).toBeInTheDocument();
  });

  test('paints no cover backdrop while the image guard hides the song', async () => {
    state.show = false;
    await renderDetail();
    await expect.element(page.getByTestId('reactions')).toBeInTheDocument();
    expect(document.querySelector('[data-testid="song-backdrop"]')).toBeNull();
  });

  test('leaves out the image-only remix gallery card', async () => {
    await renderDetail();
    await expect.element(page.getByTestId('song-more-from')).toBeInTheDocument();
    expect(document.querySelector('[data-testid="remix-gallery"]')).toBeNull();
  });

  test('has no Remix when the creator turned remixing off', async () => {
    state.image = song({ allowRemix: false });
    await renderDetail();
    await expect.element(page.getByTestId('reactions')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Save' }).first()).toBeInTheDocument();
    expect(document.querySelector('[data-testid="remix-menu"]')).toBeNull();
  });

  test('is today’s image page while the music flag is off', async () => {
    state.music = false;
    await renderDetail();
    await expect.element(page.getByTestId('reactions')).toBeInTheDocument();
    expect(document.querySelector('[data-testid="song-backdrop"]')).toBeNull();
    expect(document.querySelector('[data-testid="song-up-next"]')).toBeNull();
    expect(document.querySelector('[data-testid="song-more-from"]')).toBeNull();
    await expect.element(page.getByTestId('remix-gallery')).toBeInTheDocument();
  });
});
