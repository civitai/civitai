import type { ReactNode } from 'react';
import { DEFAULT_THEME, MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import type * as TrpcModule from '~/utils/trpc';
import type * as ImageDetailProviderModule from '~/components/Image/Detail/ImageDetailProvider';
import type * as HatTurfDetailControlsModule from '~/components/HatTurf/detail/HatTurfDetailControls';
import type * as HatTurfDetailProviderModule from '~/components/HatTurf/detail/HatTurfDetailProvider';

import '~/styles/globals.css';

// Layout test: children are fixed-size stubs so only the media column and bottom sheet are measured.
const ctx = vi.hoisted(() => ({ active: false }));
const image = {
  id: 1,
  url: 'img-1',
  nsfwLevel: 1,
  width: 700,
  height: 900,
  type: 'image',
  name: null,
  postId: 5,
  poi: false,
  minor: false,
  hasMeta: false,
  tagIds: [],
  publishedAt: new Date('2026-11-01'),
  user: { id: 2, username: 'someone' },
  stats: {},
};

vi.mock('~/components/Buzz/InteractiveTipBuzzButton', () => ({
  InteractiveTipBuzzButton: ({ children }: { children: ReactNode }) => <>{children}</>,
  useBuzzTippingStore: () => 0,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy(
    {
      'hatTurf.getStock': {
        useQuery: () => ({
          data: { available: 3, optedIn: true, mode: 'live', cap: 50, nextAt: null },
        }),
      },
      'hatTurf.getImageStickers': {
        useQuery: () => ({ data: { stickers: [], mine: null, nextCursor: null } }),
      },
      'hatTurf.getMyStickerHats': {
        useQuery: () => ({ data: [{ cosmeticId: 11, usageCount: 3, lastUsedAt: null }] }),
      },
      'event.getMyHats': {
        useQuery: () => ({ data: [{ cosmeticId: 11, name: 'Party Cap' }] }),
      },
    },
    { useUtils: () => ({ hatTurf: { getStock: { invalidate: async () => undefined } } }) }
  ),
}));
vi.mock('~/components/Image/Detail/ImageDetailProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageDetailProviderModule>()),
  useImageDetailContext: () => ({
    images: [image],
    index: 0,
    active: ctx.active,
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
  takesHats: () => true,
  HatTurfDetailProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  HatTurfDetailReset: () => null,
}));
vi.mock('~/hooks/useCurrentUser', async (o) => ({
  ...(await o<object>()),
  useCurrentUser: () => ({ id: 2, isModerator: false, muted: false, filePreferences: {} }),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (o) => ({
  ...(await o<object>()),
  useFeatureFlags: () => ({ hatTurfImageDetail: true }),
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
}));
vi.mock('~/components/Storyline/StorylineChapterRail', async (o) => ({
  ...(await o<object>()),
  StorylineChapterRail: stub,
}));
vi.mock('~/components/Ads/AdhesiveAd', async (o) => ({
  ...(await o<object>()),
  AdhesiveAd: stub,
}));
vi.mock('~/components/Ads/AdUnit', async (o) => ({
  ...(await o<object>()),
  AdUnitSide_2: stub,
  AdUnitSide_3: stub,
}));
vi.mock('~/components/Ads/AdUnitOutstream', async (o) => ({
  ...(await o<object>()),
  AdUnitOutstream: stub,
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
vi.mock('~/components/Image/DetailV2/ImageExternalMeta', async (o) => ({
  ...(await o<object>()),
  ImageExternalMeta: stub,
}));
vi.mock('~/components/Image/DetailV2/ImageGenerationData', async (o) => ({
  ...(await o<object>()),
  ImageGenerationData: stub,
}));
vi.mock('~/components/Image/DetailV2/ImagePublishedWithApp', async (o) => ({
  ...(await o<object>()),
  ImagePublishedWithApp: stub,
}));
vi.mock('~/components/RemixGallery/RemixGalleryCard', async (o) => ({
  ...(await o<object>()),
  RemixGalleryCard: stub,
}));
vi.mock('~/components/Image/DetailV2/ImageProcess', async (o) => ({
  ...(await o<object>()),
  ImageProcess: stub,
}));
vi.mock('~/components/Image/DetailV2/ImageRemixOfDetails', async (o) => ({
  ...(await o<object>()),
  ImageRemixOfDetails: stub,
}));
vi.mock('~/components/Image/DownloadImage', async (o) => ({
  ...(await o<object>()),
  DownloadImage: stub,
}));
vi.mock('~/components/Metrics', async (o) => ({
  ...(await o<object>()),
  Metrics: stub,
}));
vi.mock('~/components/Reaction/ImageReactorsPreview', async (o) => ({
  ...(await o<object>()),
  ImageReactorsPreview: stub,
}));
vi.mock('~/components/ShareButton/ShareButton', async (o) => ({
  ...(await o<object>()),
  ShareButton: stub,
}));
vi.mock('~/components/VotableTags/VotableTags', async (o) => ({
  ...(await o<object>()),
  VotableTags: stub,
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
    return <>{children(true)}</>;
  }
  ImageGuard2.BlurToggle = function BlurToggle() {
    return null;
  };
  return { ...(await o<object>()), ImageGuard2 };
});
vi.mock('~/components/Image/DetailV2/ImageDetailCarousel', () => ({
  ImageDetailCarousel: () => <div style={{ flex: 1 }} />,
}));
vi.mock('~/components/Image/DetailV2/ImageContestCollectionDetails', async (o) => ({
  ...(await o<object>()),
  useImageContestCollectionDetails: () => ({ collectionItems: [], post: undefined }),
  ImageContestCollectionDetails: () => null,
}));
vi.mock('~/components/Reaction/Reactions', async (o) => ({
  ...(await o<object>()),
  Reactions: () => null,
}));
vi.mock('~/components/TrackView/TrackView', () => ({ TrackView: () => null }));
vi.mock('~/components/Sticker/StickerPlacementBar', () => ({ StickerPlacementBar: () => null }));
vi.mock('~/components/CreatorCard/CreatorCard', async (o) => ({
  ...(await o<object>()),
  SmartCreatorCard: () => null,
}));
vi.mock('~/components/Image/Detail/ImageDetailComments', () => ({
  ImageDetailComments: () => null,
}));

import { HatTurfCardProvider } from '~/components/HatTurf/HatTurfCardProvider';
import { TurfSummaryContext } from '~/components/HatTurf/TurfSummaryProvider';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { ImageDetail2 } from '~/components/Image/DetailV2/ImageDetail2';
import { renderAtViewport } from '../../../../test/geometry-setup';

const PHONE = { width: 390, height: 844 };

async function renderDetail(inset: number) {
  document.documentElement.style.setProperty('--safe-area-inset-bottom', `${inset}px`);
  await renderAtViewport(
    // The app theme adds an `accent` palette the tip badge reads.
    <MantineProvider theme={{ colors: { accent: DEFAULT_THEME.colors.orange } }}>
      <div style={PHONE}>
        <TurfSummaryContext.Provider
          value={{
            event: 'birthday2026',
            arm: null,
            team: 'blue',
            images: {},
            open: { 1: true },
            stickers: {},
            joined: true,
            watch: () => () => undefined,
          }}
        >
          <HatTurfCardProvider>
            <ContainerProvider containerName="main">
              <ImageDetail2 />
            </ContainerProvider>
          </HatTurfCardProvider>
        </TurfSummaryContext.Provider>
      </div>
    </MantineProvider>,
    PHONE
  );
}

const q = (id: string) =>
  document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const sheet = () => q('image-detail-sheet');

afterEach(() => {
  cleanup();
  ctx.active = false;
  document.documentElement.style.removeProperty('--safe-area-inset-bottom');
});

describe('image detail on a phone: the bottom bar', () => {
  test('the hat button is a circle the size of the expand chevron', async () => {
    await renderDetail(0);
    await vi.waitFor(() => expect(q('hat-turf-detail-hat')).not.toBeNull());
    const hat = q('hat-turf-detail-hat')!.getBoundingClientRect();
    const chevron = q('image-detail-chevron')!.getBoundingClientRect();
    expect(chevron.height).toBe(36);
    expect(hat.height).toBe(chevron.height);
    expect(hat.width).toBe(chevron.width);
  });
});
