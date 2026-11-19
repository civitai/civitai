// The real cascade, so the detail view lays out as on the site.
import '../../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import type { ComponentProps, ReactNode } from 'react';
import { DEFAULT_THEME, MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import type * as TrpcModule from '~/utils/trpc';
import type * as ImageDetailProviderModule from '~/components/Image/Detail/ImageDetailProvider';
import { mergeDetailItems } from '~/components/Image/Detail/detail-items';
import type * as HatTurfDetailControlsModule from '~/components/HatTurf/detail/HatTurfDetailControls';
import type * as HatTurfDetailProviderModule from '~/components/HatTurf/detail/HatTurfDetailProvider';
import type * as ImageDetailCarouselModule from '~/components/Image/DetailV2/ImageDetailCarousel';

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

const state = vi.hoisted(() => ({
  music: true,
  show: true,
  image: null as unknown,
  // The real carousel and stage, for layout; a probe otherwise.
  realCarousel: false,
  images: null as unknown[] | null,
  index: 0,
  highlight: undefined as number | undefined,
  lyrics: [] as { t: number | null; text: string }[],
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy({
    'image.getSongLyrics': {
      useQuery: () => ({ data: state.lyrics, isLoading: false, isError: false }),
    },
  }),
}));
vi.mock('~/components/Image/Detail/ImageDetailProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageDetailProviderModule>()),
  useImageDetailContext: () => ({
    images: state.images ?? [state.image],
    items: mergeDetailItems(
      (state.images ?? [state.image]) as { id: number; postId: number }[],
      undefined
    ),
    navigateTo: () => undefined,
    index: state.index,
    active: false,
    close: () => undefined,
    toggleInfo: () => undefined,
    shareUrl: '/images/1',
    navigate: () => undefined,
    loadMore: () => undefined,
    hasMore: false,
    collection: undefined,
    hideReactions: false,
    highlight: state.highlight,
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
  const ImageGuardContent = ({ children }: { children: (safe: boolean) => ReactNode }) => (
    <>{children(state.show)}</>
  );
  return { ...(await o<object>()), ImageGuard2, ImageGuardContent };
});
vi.mock('~/components/Image/DetailV2/ImageDetailCarousel', async (importOriginal) => {
  const actual = await importOriginal<typeof ImageDetailCarouselModule>();
  return {
    ...actual,
    ImageDetailCarousel: (props: ComponentProps<typeof actual.ImageDetailCarousel>) =>
      state.realCarousel ? (
        <actual.ImageDetailCarousel {...props} />
      ) : (
        <div data-testid="carousel" />
      ),
  };
});
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

vi.mock('~/components/Music/SongDetail/useMoreFromCreator', () => ({
  useMoreFromCreator: () => [],
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
const { PageModal } = await import('~/components/Dialog/Templates/PageModal');

function renderDetail(size = { width: 1280, height: 900 }) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider theme={{ colors: { accent: DEFAULT_THEME.colors.orange } }}>
        <div style={size}>
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
  state.realCarousel = false;
  state.images = null;
  state.index = 0;
  state.highlight = undefined;
  state.lyrics = [];
  localStorage.removeItem('image-detail-open');
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

describe('a song between other songs (the creator’s list the global player opens it in)', () => {
  // The carousel mounts the slides either side too; three song stages side by side are wider
  // than the stage, and they used to widen it and push the sidebar off the window (S13).
  test('keeps the sidebar inside the window', async () => {
    await page.viewport(1920, 1000);
    state.realCarousel = true;
    state.images = [1, 2, 3].map((id) => ({ ...song({}), id }));
    state.image = state.images[1];
    state.index = 1;
    await renderDetail({ width: 1920, height: 1000 });
    await expect.element(page.getByTestId('creator-card')).toBeInTheDocument();
    await expect
      .poll(() => document.querySelectorAll('[data-testid="song-detail-stage"]').length)
      .toBe(3);
    const sheet = page.getByTestId('image-detail-sheet').element().getBoundingClientRect();
    expect(sheet.width).toBe(450);
    expect(sheet.right).toBeLessThanOrEqual(1920);
  });
});

describe('a link to one of the song’s comments', () => {
  // The reader folded the sidebar away on an earlier visit.
  beforeEach(() => localStorage.setItem('image-detail-open', 'false'));

  test('shows the sidebar the comment is in', async () => {
    state.highlight = 777;
    await renderDetail();
    await expect.element(page.getByTestId('creator-card')).toBeInTheDocument();
    await expect
      .poll(() => page.getByTestId('image-detail-sheet').element().getBoundingClientRect().width)
      .toBe(450);
    await expect.poll(() => localStorage.getItem('image-detail-open')).toBe('true');
  });

  test('without one, the folded sidebar stays folded', async () => {
    await renderDetail();
    await expect.element(page.getByTestId('song-backdrop')).toBeInTheDocument();
    expect(page.getByTestId('image-detail-sheet').element().getBoundingClientRect().width).toBe(0);
  });
});

describe('the song stage beside the open sidebar', () => {
  const LYRICS = [
    'Neon rain on the arcade glass, every coin a little wish',
    'We were kings of the high score table until the morning came',
    'Midnight arcade, midnight arcade, keep the lights on for me',
  ].map((text, i) => ({ t: i * 10_000, text }));

  // The window sizes the user reported at and the narrowest desktop one, each with and without lyrics.
  for (const [width, height] of [
    [1860, 1080],
    [1280, 900],
  ])
    for (const withLyrics of [false, true])
      test(`fits left of the sidebar at ${width}px ${
        withLyrics ? 'with lyrics' : 'without lyrics'
      }`, async () => {
        await page.viewport(width, height);
        state.realCarousel = true;
        state.lyrics = withLyrics ? LYRICS : [];
        // Among the creator's other songs, as the detail view usually opens it.
        state.images = [1, 2, 3].map((id) => ({ ...song({}), id }));
        state.image = state.images[1];
        state.index = 1;
        await renderDetail({ width, height });
        const stage = page.getByTestId('song-detail-stage').nth(1);
        await expect.element(stage).toBeInTheDocument();
        await expect
          .element(
            withLyrics
              ? stage.getByTestId('song-lyrics')
              : stage.getByText('No lyrics on this one.')
          )
          .toBeVisible();
        const sheet = page.getByTestId('image-detail-sheet').element().getBoundingClientRect();
        expect(sheet.width).toBe(450);
        expect(sheet.right).toBeLessThanOrEqual(width);
        // The stage is a carousel slide, so measure within it: no wider than the room left of the
        // sidebar, and nothing in it past its right edge.
        const box = stage.element().getBoundingClientRect();
        const contentRight = Math.max(
          ...[...stage.element().querySelectorAll('*')].map(
            (el) => el.getBoundingClientRect().right
          )
        );
        expect({ stage: box.width, overflow: Math.max(0, contentRight - box.right) }).toEqual({
          stage: sheet.left,
          overflow: 0,
        });
      });
});

describe('the sidebar toggle', () => {
  test('is named for what it does, and the name follows the state', async () => {
    await renderDetail();
    const hide = page.getByRole('button', { name: 'Hide details' });
    await expect.element(hide).toHaveAttribute('aria-expanded', 'true');
    await hide.click();
    const show = page.getByRole('button', { name: 'Show details' });
    await expect.element(show).toHaveAttribute('aria-expanded', 'false');
    await show.click();
    await expect.element(page.getByRole('button', { name: 'Hide details' })).toBeInTheDocument();
  });
});

describe('the detail view over the site with the player bar open', () => {
  const BAR = 72;
  // The site's column as BaseLayout builds it: the page row, then the player bar as the last row.
  // The detail view opens as a routed dialog inside `#main` (`ImageDetailModal`: a full-screen
  // PageModal, not portalled).
  function renderUnderBar(withBar: boolean) {
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <MantineProvider theme={{ colors: { accent: DEFAULT_THEME.colors.orange } }}>
          <div className="flex h-screen flex-col">
            <div className="flex flex-1 overflow-hidden">
              <ContainerProvider id="main" containerName="main" className="flex-1">
                <PageModal
                  opened
                  onClose={() => undefined}
                  withCloseButton={false}
                  withinPortal={false}
                  withOverlay={false}
                  lockScroll={false}
                  padding={0}
                  fullScreen
                >
                  <ClientOnlySectionsProvider enabled={false}>
                    <ImageDetail2 />
                  </ClientOnlySectionsProvider>
                </PageModal>
              </ContainerProvider>
            </div>
            {withBar && (
              <div data-music-player-bar="" className="shrink-0" style={{ height: BAR }} />
            )}
          </div>
        </MantineProvider>
      </QueryClientProvider>
    );
  }

  for (const withBar of [true, false])
    test(`ends ${
      withBar ? 'above the bar' : 'at the window’s bottom'
    }, its last card reachable`, async () => {
      await page.viewport(1860, 1080);
      await renderUnderBar(withBar);
      await expect.element(page.getByTestId('song-more-from')).toBeInTheDocument();
      const bottom = withBar ? 1080 - BAR : 1080;
      const sheet = page.getByTestId('image-detail-sheet').element();
      expect(sheet.getBoundingClientRect().bottom).toBeLessThanOrEqual(bottom);
      const last = page.getByTestId('song-more-from').element();
      last.scrollIntoView({ block: 'end' });
      await expect.poll(() => last.getBoundingClientRect().bottom).toBeLessThanOrEqual(bottom);
    });
});
