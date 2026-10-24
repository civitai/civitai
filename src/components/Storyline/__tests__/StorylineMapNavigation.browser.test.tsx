import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import Router from 'next/router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { QS } from '~/utils/qs';
import { useCarouselNavigation } from '~/hooks/useCarouselNavigation';
import { withStorylineNavigation } from '~/components/Storyline/storyline-mode.utils';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';
import type * as QueriesModule from '~/components/Storyline/storyline.queries';
import type { StorylinePathChapter } from '~/server/services/storyline.service';

type Chapter = StorylinePathChapter & { parentCount?: number; childCount?: number };

const chapter = (chapterId: number, depth: number, postId: number): Chapter =>
  ({
    chapterId,
    depth,
    tombstone: null,
    parentCount: 1,
    childCount: 1,
    joins: [],
    post: { id: postId, title: `ch${chapterId}`, userId: 1, username: 'u1' },
    firstImage: { id: postId / 10, url: `img-${postId / 10}`, nsfwLevel: 1, type: 'image' },
  } as Chapter);

// Storyline 1 on prod: 1 -> 2 -> {3 canon, 5}; 5 -> 6 -> {7, 9 canon}; 7 -> 8 (not canon).
const route = [chapter(1, 0, 100), chapter(2, 1, 200), chapter(5, 2, 500), chapter(6, 3, 600)];
const paths: Record<number, Chapter[]> = {
  7: [...route, chapter(7, 4, 700)],
  8: [...route, chapter(7, 4, 700), chapter(8, 5, 800)],
};
const imageOf = (postId: number) => ({ id: postId / 10, postId, index: 0 });

const mocks = vi.hoisted(() => ({ unwalkedPostIds: new Set<number>() }));

const later = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 80));

vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesModule>()),
  useStorylinesEnabled: () => true,
  useHiddenUserIds: () => new Set<number>(),
  useStorylineTracking: () => ({ trackBranchChoice: vi.fn(), trackCreateClick: vi.fn() }),
  useStorylinePath: (chapterId: number | undefined) =>
    useQuery({
      queryKey: ['path', chapterId],
      enabled: !!chapterId,
      placeholderData: keepPreviousData,
      queryFn: () =>
        later({
          storyline: { id: 1, title: 'Who', userId: 1, maxNsfwLevel: 1 },
          chapters: paths[chapterId as number],
          captions: {},
          hasEarlier: false,
        }),
    }),
  useStorylinePathImages: (chapters: Chapter[] | undefined) => {
    const postIds = (chapters ?? []).flatMap((c) => (c.post ? [c.post.id] : []));
    const query = useQuery({
      queryKey: ['images', postIds, [...mocks.unwalkedPostIds]],
      enabled: postIds.length > 0,
      placeholderData: keepPreviousData,
      queryFn: () => later(postIds.filter((id) => !mocks.unwalkedPostIds.has(id)).map(imageOf)),
    });
    return {
      images: query.data ?? [],
      isLoading: postIds.length > 0 && query.isLoading,
      isFetching: query.isFetching,
    };
  },
  useStorylineCanonAhead: () => ({
    ahead: [],
    childrenByChapterId: new Map(),
    isLoading: false,
    isSuccess: true,
  }),
  useStorylinePathChildren: () =>
    new Map([[7, [{ ...chapter(8, 5, 800), rank: 'community', firstImage: null }]]]),
  useStorylineForkShares: () => ({ data: undefined }),
}));
vi.mock('~/components/PageLoader/PageLoader', () => ({ PageLoader: () => null }));
vi.mock('~/components/Storyline/StorylineChapterImage', async (o) => ({
  ...(await o<object>()),
  StorylineChapterImage: () => null,
}));
vi.mock('~/components/ImageGuard/ImageGuard2', async (o) => ({
  ...(await o<object>()),
  ImageGuardContent: () => null,
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', async (o) => ({
  ...(await o<object>()),
  EdgeMedia: () => null,
}));
vi.mock('~/components/Sticker/ImageStickerOverlay', async (o) => ({
  ...(await o<object>()),
  ImageStickerOverlay: () => null,
}));
vi.mock('~/components/Cosmetics/EventDecoration/DrawnMediaHat', async (o) => ({
  ...(await o<object>()),
  DrawnMediaHat: () => null,
}));
vi.mock('~/components/ImageHash/ImageHash', async (o) => ({
  ...(await o<object>()),
  MediaHash: () => null,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (o) => ({
  ...(await o<object>()),
  useFeatureFlags: () => ({}),
}));
// Out of the mode for a render, the toolbar offers the post's own storyline instead.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy(),
}));

import {
  BrowserRouterProvider,
  getBrowserRouter,
  useBrowserRouter,
} from '~/components/BrowserRouter/BrowserRouterProvider';
import {
  StorylineModeProvider,
  useStorylineMode,
} from '~/components/Storyline/StorylineModeProvider';
import { ImageDetailCarousel } from '~/components/Image/DetailV2/ImageDetailCarousel';
import { StorylineToolbarChip } from '~/components/Storyline/StorylineDetail';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';

const imageProps = (id: number) => ({
  id,
  nsfwLevel: 1,
  url: `img-${id}`,
  height: 10,
  width: 10,
  type: 'image' as const,
  name: null,
});

/** ImageDetail2's carousel wiring, copied: the provider's index, its own carousel state, the sync. */
function Detail({
  placement,
  walked,
}: {
  placement: 'toolbar' | 'mobile';
  walked: { id: number }[];
}) {
  const browserRouter = useBrowserRouter();
  const imageId = Number(browserRouter.query.imageId);
  const storyline = useStorylineMode();
  const images = walked.map((image) => imageProps(image.id));
  const found = images.findIndex((x) => x.id === imageId);
  const index = found > -1 ? found : 0;
  const navigate = (id: number) => {
    const [, queryString] = browserRouter.asPath.split('?');
    browserRouter.replace(
      { query: { ...browserRouter.query, imageId: id } },
      { pathname: `/images/${id}`, query: QS.parse(queryString) as Record<string, string> }
    );
  };
  const carouselNavigation = useCarouselNavigation({ items: images, initialIndex: index });
  const navigation = withStorylineNavigation(
    carouselNavigation,
    images.length,
    storyline.active ? () => storyline.setEndOpen(true) : undefined
  );
  const lastSettledIdRef = useRef(images[index]?.id);
  const handleSettle = (settledIndex: number) => {
    const settled = images[settledIndex];
    if (!settled || lastSettledIdRef.current === settled.id) return;
    lastSettledIdRef.current = settled.id;
    navigate(settled.id);
  };
  const carouselNavigate = carouselNavigation.navigate;
  useEffect(() => {
    const target = images[index];
    if (!storyline.active || !target || target.id === lastSettledIdRef.current) return;
    lastSettledIdRef.current = target.id;
    carouselNavigate(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, storyline.active]);
  const shown = images[carouselNavigation.index]?.id;
  return (
    <div style={{ width: 400, height: 300, display: 'flex' }}>
      <output data-testid="image">{shown}</output>
      <ImageDetailCarousel
        images={images}
        onSettle={handleSettle}
        loop={!storyline.active}
        {...navigation}
      />
      {shown && <StorylineToolbarChip imageId={shown} postId={shown * 10} placement={placement} />}
    </div>
  );
}

function Reader({ placement }: { placement: 'toolbar' | 'mobile' }) {
  return (
    <StorylineModeProvider>
      {(walked, modeKey) => <Detail key={modeKey} placement={placement} walked={walked ?? []} />}
    </StorylineModeProvider>
  );
}

async function openReader(storylineChapter: number, width: number) {
  await page.viewport(width, 800);
  const asPath = `/images/70?storylineChapter=${storylineChapter}`;
  Object.assign(Router, {
    query: { imageId: '70', storylineChapter: String(storylineChapter) },
    asPath,
    pathname: '/images/[imageId]',
  });
  renderWithProviders(
    <BrowserRouterProvider>
      <ContainerProvider containerName="stage" style={{ width }}>
        <Reader placement={width < 768 ? 'mobile' : 'toolbar'} />
      </ContainerProvider>
    </BrowserRouterProvider>
  );
  await expect.element(page.getByTestId('image')).toBeInTheDocument();
  getBrowserRouter().replace({ query: { imageId: 70, storylineChapter } }, asPath);
  await expect.element(page.getByTestId('image')).toHaveTextContent('70');
  await page.getByRole('button', { name: /map/i }).first().click();
}

/**
 * Tester report, storyline 1 on prod: on chapter 5 of a branch off the main route, neither the
 * map's chapter 6 row nor "Read chapter 6" moved the reader. The mode put chapter 6's image in the
 * URL without remounting the detail, so the picture stayed on chapter 5 and every later click asked
 * for the URL it already had.
 */
/**
 * Tester report, storyline 1 on prod: on chapter 5 of a branch off the main route, with chapter 6
 * after it on the path, neither the map's chapter 6 row nor "Read chapter 6" moved the reader.
 * The detail here is ImageDetail2's carousel wiring around the real embla carousel. The two jump
 * tests pass on Chromium without any fix: they do not reproduce the report, they guard the path.
 */
describe('the map from chapter 5 of a non-canon route', () => {
  afterEach(() => {
    mocks.unwalkedPostIds.clear();
    vi.mocked(Router.push).mockClear();
    // The router store is module state that outlives a render; leave it where the next test opens.
    getBrowserRouter().replace(
      { query: { imageId: 70, storylineChapter: 8 } },
      '/images/70?storylineChapter=8'
    );
  });

  for (const width of [1200, 375])
    test(`"Read chapter 6" moves the reader to chapter 6, ${width}px`, async () => {
      await openReader(8, width);
      await page.getByTestId('storyline-map-read-next').click();
      await expect.element(page.getByTestId('image')).toHaveTextContent('80');
    });

  // Pinned for whoever finds the fallback odd: a chapter whose images are not walked yet (paging
  // in, or past the cap) used to make the click do nothing at all.
  test('a chapter whose images are not walked opens from its own link instead of doing nothing', async () => {
    mocks.unwalkedPostIds.add(800);
    await openReader(8, 1200);
    await page.getByTestId('storyline-map-read-next').click();
    expect(Router.push).toHaveBeenCalledWith('/images/80?storylineChapter=8');
    await expect.element(page.getByTestId('image')).toHaveTextContent('70');
  });
});
