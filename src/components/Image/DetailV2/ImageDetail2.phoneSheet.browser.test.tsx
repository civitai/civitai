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

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy(),
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
vi.mock('~/components/HatTurf/detail/HatTurfDetailControls', async (importOriginal) => ({
  ...(await importOriginal<typeof HatTurfDetailControlsModule>()),
  HatTurfDetailControls: () => <div data-testid="hat-controls" style={{ width: 70, height: 36 }} />,
  HatTurfDetailBadge: () => <div data-testid="hat-badge" style={{ width: 36, height: 36 }} />,
}));
vi.mock('~/hooks/useCurrentUser', async (o) => ({
  ...(await o<object>()),
  useCurrentUser: () => null,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (o) => ({
  ...(await o<object>()),
  useFeatureFlags: () => ({}),
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
vi.mock('~/components/Image/Remix/RemixMenu', async (o) => ({
  ...(await o<object>()),
  RemixMenu: stub,
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

import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { ImageDetail2 } from '~/components/Image/DetailV2/ImageDetail2';
import { renderWithProviders } from '../../../../test/component-setup';

const PHONE = { width: 390, height: 844 };

function renderDetail(inset: number) {
  document.documentElement.style.setProperty('--safe-area-inset-bottom', `${inset}px`);
  renderWithProviders(
    // The app theme adds an `accent` palette the tip badge reads.
    <MantineProvider theme={{ colors: { accent: DEFAULT_THEME.colors.orange } }}>
      <div style={PHONE}>
        <ContainerProvider containerName="main">
          <ImageDetail2 />
        </ContainerProvider>
      </div>
    </MantineProvider>
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

describe('image detail on a phone', () => {
  test.each([0, 34])(
    'the collapsed sheet leaves the controls under the image uncovered (bottom inset %ipx)',
    async (inset) => {
      renderDetail(inset);
      await vi.waitFor(() => expect(q('hat-controls')).not.toBeNull());
      await vi.waitFor(() => expect(sheet()).not.toBeNull());
      const controls = q('hat-controls')!.getBoundingClientRect();
      const strip = sheet()!.getBoundingClientRect();
      expect(strip.top).toBeLessThan(PHONE.height);
      expect(controls.bottom).toBeLessThanOrEqual(strip.top);
    }
  );

  test('the expanded sheet has no Hat Turf badge: the one on the image is the control', async () => {
    ctx.active = true;
    renderDetail(0);
    await vi.waitFor(() => expect(sheet()).not.toBeNull());
    expect(q('hat-controls')).not.toBeNull();
    expect(sheet()!.querySelector('[data-testid="hat-badge"]')).toBeNull();
  });
});
