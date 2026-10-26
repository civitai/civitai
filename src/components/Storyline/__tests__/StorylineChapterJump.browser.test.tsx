import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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

const PER_CHAPTER = 4;
const chapter = (chapterId: number, depth: number): Chapter =>
  ({
    chapterId,
    depth,
    tombstone: null,
    parentCount: 1,
    childCount: 1,
    joins: [],
    post: { id: chapterId * 100, title: `ch${chapterId}`, userId: 1, username: 'u1' },
    firstImage: { id: chapterId * 100 + 1, url: 'x', nsfwLevel: 1, type: 'image' },
  } as Chapter);

// 1 -> 2 -> 3 -> 4, then the reader's branch 15 -> 16 -> {17}, beside the canon 25 off 4.
// Each chapter is a post of PER_CHAPTER images: chapter 15 owns 1501..1504.
const byId: Record<number, Chapter> = Object.fromEntries(
  [1, 2, 3, 4, 15, 16, 17, 25].map((id) => [
    id,
    chapter(id, id === 25 ? 4 : id > 4 ? id - 11 : id - 1),
  ])
);
byId[16].parentCount = 2;
const trunk = [1, 2, 3, 4].map((id) => byId[id]);
// 16 is where the branches rejoin: its path runs through 25 (the oldest link) unless `via` names 15.
const pathTo = (id: number, via: number[]) => {
  const to16 = [...trunk, via.includes(15) ? byId[15] : byId[25], byId[16]];
  return id === 15 ? [...trunk, byId[15]] : id === 16 ? to16 : [...to16, byId[17]];
};
const imagesOf = (postId: number) =>
  Array.from({ length: PER_CHAPTER }, (_, k) => ({ id: postId + k + 1, postId, index: k }));

const delays = vi.hoisted(() => ({ path: 80, images: 80 }));
const later = <T,>(value: T, ms: number) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesModule>()),
  useStorylinesEnabled: () => true,
  useHiddenUserIds: () => new Set<number>(),
  useStorylineTracking: () => ({ trackBranchChoice: vi.fn(), trackCreateClick: vi.fn() }),
  useStorylinePath: (chapterId: number | undefined, via: number[] = []) =>
    useQuery({
      queryKey: ['path', chapterId, via],
      enabled: !!chapterId,
      placeholderData: keepPreviousData,
      queryFn: () =>
        later(
          {
            storyline: { id: 1, title: 'Fork', userId: 1, maxNsfwLevel: 1 },
            chapters: pathTo(chapterId as number, via),
            captions: {},
            hasEarlier: false,
          },
          delays.path
        ),
    }),
  useStorylinePathImages: (chapters: Chapter[] | undefined) => {
    const postIds = (chapters ?? []).flatMap((c) => (c.post ? [c.post.id] : []));
    const query = useQuery({
      queryKey: ['images', postIds],
      enabled: postIds.length > 0,
      placeholderData: keepPreviousData,
      queryFn: () => later(postIds.flatMap(imagesOf), delays.images),
    });
    return {
      images: query.data ?? [],
      isLoading: postIds.length > 0 && query.isLoading,
      isFetching: query.isFetching,
    };
  },
  useStorylineCanonAhead: (endId: number | undefined) => ({
    ahead: endId === 15 ? [byId[16]] : [],
    childrenByChapterId: new Map(),
    isLoading: false,
    isSuccess: true,
  }),
  useStorylinePathChildren: () =>
    new Map([
      [4, [{ ...byId[25], rank: 'canon', firstImage: null }]],
      [16, [{ ...byId[17], rank: 'community', firstImage: null }]],
    ]),
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

async function openReader({
  routeChapter,
  imageId,
  via = [],
  width = 1200,
  openMap = true,
}: {
  routeChapter: number;
  imageId: number;
  via?: number[];
  width?: number;
  openMap?: boolean;
}) {
  await page.viewport(width, 800);
  const viaQuery = via.length ? `&storylineVia=${via.join(',')}` : '';
  const asPath = `/images/${imageId}?storylineChapter=${routeChapter}${viaQuery}`;
  Object.assign(Router, {
    query: {
      imageId: String(imageId),
      storylineChapter: String(routeChapter),
      ...(via.length ? { storylineVia: via.join(',') } : {}),
    },
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
  getBrowserRouter().replace(
    {
      query: {
        imageId,
        storylineChapter: routeChapter,
        ...(via.length ? { storylineVia: via.join(',') } : {}),
      },
    },
    asPath
  );
  await expect.element(page.getByTestId('image')).toHaveTextContent(String(imageId));
  await new Promise((r) => setTimeout(r, Math.max(delays.images, delays.path) + 300));
  if (openMap) await page.getByRole('button', { name: /map/i }).first().click();
}

const timings: [number, number][] = [
  [10, 400],
  [400, 10],
  [400, 400],
  [10, 10],
];
describe.each(timings)(
  'moving forward from the middle of chapter 5 of a branch, path %ims images %ims',
  (path, images) => {
    beforeEach(() => Object.assign(delays, { path, images }));
    afterEach(() => {
      getBrowserRouter().replace({ query: { imageId: 1, storylineChapter: 15 } }, '/images/1');
    });

    // 15: chapter 6 is the canon line ahead. 16: it is on the path, and chapter 7 is a way off it.
    for (const routeChapter of [15, 16]) {
      test(`"Read chapter 6" lands on chapter 6 (path ends at ${routeChapter})`, async () => {
        await openReader({ routeChapter, imageId: 1502, via: routeChapter === 16 ? [15] : [] });
        await page.getByTestId('storyline-map-read-next').click();
        await expect.element(page.getByTestId('image')).toHaveTextContent('1601');
      });

      test(`the map's chapter 6 row lands on chapter 6 (path ends at ${routeChapter})`, async () => {
        await openReader({ routeChapter, imageId: 1502, via: routeChapter === 16 ? [15] : [] });
        await page.getByTestId('storyline-stop').nth(5).click();
        await expect.element(page.getByTestId('image')).toHaveTextContent('1601');
      });
    }

    test('a way on after chapter 6 lands on chapter 7', async () => {
      await openReader({ routeChapter: 16, imageId: 1602, via: [15] });
      await page.getByRole('button', { name: 'ch17' }).click();
      await expect.element(page.getByTestId('image')).toHaveTextContent('1701');
    });

    test('a jump straight after paging an image still lands', async () => {
      await openReader({ routeChapter: 15, imageId: 1502, openMap: false });
      await page.getByRole('button', { name: 'Next image' }).click();
      await page.getByRole('button', { name: /map/i }).first().click();
      await page.getByTestId('storyline-map-read-next').click();
      await expect.element(page.getByTestId('image')).toHaveTextContent('1601');
    });
  }
);
