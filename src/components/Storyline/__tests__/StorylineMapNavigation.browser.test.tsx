import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import Router from 'next/router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
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

// A branch beside the canon chapter 5: 21 -> 22 -> 23 -> 24 -> {25 canon, 35}; 35 -> 36 -> {37, 38}.
const main = [
  chapter(21, 0, 2100),
  chapter(22, 1, 2200),
  chapter(23, 2, 2300),
  chapter(24, 3, 2400),
];
const b5 = chapter(35, 4, 3500);
const b6 = { ...chapter(36, 5, 3600), childCount: 2 };
Object.assign(paths, {
  35: [...main, b5],
  36: [...main, b5, b6],
  37: [...main, b5, b6, chapter(37, 6, 3700)],
});
// Chapter 5 with a community chapter 6 after it and no canon child: 21 -> 22 -> 23 -> 24 -> 45 -> 46.
const c5 = chapter(45, 4, 4500);
const c6 = chapter(46, 5, 4600);
Object.assign(paths, { 45: [...main, c5], 46: [...main, c5, c6] });
const child = (c: Chapter) => ({ ...c, rank: 'community', firstImage: null });
const childrenOf: Record<number, unknown[]> = {
  7: [child(chapter(8, 5, 800))],
  24: [{ ...child(chapter(25, 4, 2500)), rank: 'canon' }, child(b5)],
  35: [child(b6)],
  45: [child(c6)],
  36: [child(chapter(37, 6, 3700)), child(chapter(38, 6, 3800))],
};
const childrenByChapterId = (ids: number[]) =>
  new Map(ids.flatMap((id) => (childrenOf[id] ? [[id, childrenOf[id]] as const] : [])));
// The canon line ahead of a path's end: from B5 it is B6, which has no canon child.
const aheadOf: Record<number, Chapter[]> = { 35: [b6] };
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
  useStorylineCanonAhead: (chapterId: number | undefined) => {
    const ahead = aheadOf[chapterId as number] ?? [];
    return {
      ahead,
      childrenByChapterId: childrenByChapterId(ahead.map((c) => c.chapterId)),
      isLoading: false,
      isSuccess: true,
    };
  },
  useStorylinePathChildren: (ids: number[]) => childrenByChapterId(ids),
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
import {
  ImageDetailCarousel,
  SETTLE_FALLBACK_MS,
} from '~/components/Image/DetailV2/ImageDetailCarousel';
import { useCarouselUrlSync } from '~/components/Image/DetailV2/useCarouselUrlSync';
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

/** ImageDetail2's carousel wiring: the provider's index, its own carousel state, the shared sync. */
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
  const handleSettle = useCarouselUrlSync({
    images,
    index,
    navigate,
    carouselNavigate: carouselNavigation.navigate,
  });
  const shown = images[carouselNavigation.index]?.id;
  return (
    <div style={{ width: 400, height: 300, display: 'flex' }}>
      <output data-testid="image">{shown}</output>
      <button type="button" data-testid="previous" onClick={navigation.previous} />
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

// The harness loads no Tailwind. Embla measures its slides, and unstyled ones are not 100% wide,
// so without these rules it snaps to the wrong image (CI run 40122629075 landed on chapter 2).
const layout = document.createElement('style');
layout.textContent = `
.flex{display:flex}.flex-1{flex:1 1 0%}.min-h-0{min-height:0}.h-full{height:100%}
.items-stretch{align-items:stretch}.justify-stretch{justify-content:stretch}
.overflow-hidden{overflow:hidden}.relative{position:relative}
.flex-\\[0_0_100\\%\\]{flex:0 0 100%;min-width:0}
`;
document.head.appendChild(layout);

async function openReader(storylineChapter: number, width: number, imageId = 70) {
  await page.viewport(width, 800);
  const asPath = `/images/${imageId}?storylineChapter=${storylineChapter}`;
  Object.assign(Router, {
    query: { imageId: String(imageId), storylineChapter: String(storylineChapter) },
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
  getBrowserRouter().replace({ query: { imageId, storylineChapter } }, asPath);
  await expect.element(page.getByTestId('image')).toHaveTextContent(String(imageId));
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

/**
 * Chapter 5 is a branch (B5) beside the canon chapter 5, chapter 6 (B6) follows it, and B6 forks
 * with no canon child.
 */
describe('the map from a branch chapter 5 beside the canon one', () => {
  afterEach(() => {
    getBrowserRouter().replace(
      { query: { imageId: 70, storylineChapter: 8 } },
      '/images/70?storylineChapter=8'
    );
  });

  // Entered at B5 (from the story page, or chosen at the end of chapter 4): B6 is the canon ahead.
  test('"Read chapter 6" opens B6', async () => {
    await openReader(35, 1200, 350);
    await page.getByTestId('storyline-map-read-next').click();
    await expect.element(page.getByTestId('image')).toHaveTextContent('360');
  });

  test('the chapter 6 row opens B6', async () => {
    await openReader(35, 1200, 350);
    await page.getByText('ch36').click();
    await expect.element(page.getByTestId('image')).toHaveTextContent('360');
  });

  test('a chapter 7 branch opens that chapter', async () => {
    await openReader(35, 1200, 350);
    await page.getByText('ch37').click();
    await expect.element(page.getByTestId('image')).toHaveTextContent('370');
  });
});

/**
 * The address bar trails the carousel until it settles. A map click inside that window, here in the
 * same task as the swipe back from B6 to B5, must still land where the reader chose.
 */
describe('the map clicked before a swipe back has settled', () => {
  afterEach(() => {
    getBrowserRouter().replace(
      { query: { imageId: 70, storylineChapter: 8 } },
      '/images/70?storylineChapter=8'
    );
  });

  const control = (target: string) =>
    [...document.querySelectorAll<HTMLElement>('button')].find(
      (el) => el.dataset.testid === target || el.textContent?.includes(target)
    );
  const swipeBackThenClick = async (target: string) => {
    document.querySelector<HTMLElement>('[data-testid="previous"]')?.click();
    // "Read chapter 6" only shows once the map sees B5.
    await vi.waitFor(() => expect(control(target)).toBeDefined(), { interval: 1 });
    expect(getBrowserRouter().query?.imageId, 'the swipe settled before the click').toBe(360);
    control(target)?.click();
  };

  for (const target of ['ch36', 'storyline-map-read-next'])
    test(`${target} brings the reader back to B6`, async () => {
      await openReader(36, 1200, 360);
      await swipeBackThenClick(target);
      // Past the carousel's settle fallback: the swipe's late settle must not drag it back.
      await new Promise((resolve) => setTimeout(resolve, SETTLE_FALLBACK_MS * 2));
      await expect.element(page.getByTestId('image')).toHaveTextContent('360');
    });

  test('a chapter 7 branch opens that chapter', async () => {
    await openReader(36, 1200, 360);
    await swipeBackThenClick('ch37');
    await new Promise((resolve) => setTimeout(resolve, SETTLE_FALLBACK_MS * 2));
    await expect.element(page.getByTestId('image')).toHaveTextContent('370');
  });
});

// The path says the reader may see chapter 6's first image; the walk's image read lacks it.
describe('a branch chapter whose first image is not in the walk', () => {
  afterEach(() => {
    mocks.unwalkedPostIds.clear();
    vi.mocked(Router.push).mockClear();
    getBrowserRouter().replace(
      { query: { imageId: 70, storylineChapter: 8 } },
      '/images/70?storylineChapter=8'
    );
  });

  test('taking it opens its own link instead of leaving the reader on chapter 5', async () => {
    mocks.unwalkedPostIds.add(4600);
    await openReader(45, 1200, 450);
    await page.getByText('ch46').click();
    await vi.waitFor(() =>
      expect(Router.push).toHaveBeenCalledWith('/images/460?storylineChapter=46')
    );
    expect(Router.push).toHaveBeenCalledTimes(1);
  });
});
