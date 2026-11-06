import { useEffect } from 'react';
import Router from 'next/router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import {
  BrowserRouterProvider,
  getBrowserRouter,
  useBrowserRouter,
} from '~/components/BrowserRouter/BrowserRouterProvider';
import {
  ImageDetailProvider,
  useImageDetailContext,
} from '~/components/Image/Detail/ImageDetailProvider';
import { ImageDetailCarousel } from '~/components/Image/DetailV2/ImageDetailCarousel';
import { useCarouselUrlSync } from '~/components/Image/DetailV2/useCarouselUrlSync';
import { useCarouselNavigation } from '~/hooks/useCarouselNavigation';
import { renderWithProviders } from '../../../../test/component-setup';

const image = (id: number) => ({
  id,
  nsfwLevel: 1,
  url: `img-${id}`,
  height: 10,
  width: 10,
  type: 'image' as const,
  name: null,
  user: { id: 9 },
  poi: false,
  minor: false,
  tagIds: [] as number[],
});

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy({
    // Answers from the cache the remix card already filled: no loading state, so the detail
    // that is open never unmounts while the source arrives.
    'image.get': {
      useQuery: ({ id }: { id: number }) => ({
        data: image(id),
        isLoading: false,
        isInitialLoading: false,
      }),
    },
  }),
}));
vi.mock('~/components/PageLoader/PageLoader', () => ({ PageLoader: () => null }));
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
vi.mock('~/hooks/useCurrentUser', async (o) => ({
  ...(await o<object>()),
  useCurrentUser: () => null,
}));
vi.mock('~/store/ClientHistoryStore', async (o) => ({
  ...(await o<object>()),
  useHasClientHistory: () => true,
}));
vi.mock('~/components/HiddenPreferences/HiddenPreferencesProvider', async (o) => ({
  ...(await o<object>()),
  useHiddenPreferencesContext: () => ({
    hiddenUsers: new Map(),
    hiddenTags: new Map(),
    hiddenImages: new Map(),
    hiddenModels: new Map(),
    blockedUsers: new Map(),
    moderatedTags: [],
    systemHiddenTags: new Map(),
    isLoading: false,
    hiddenLoading: false,
  }),
}));
vi.mock('~/hooks/hidden-preferences', async (o) => ({
  ...(await o<object>()),
  useHiddenPreferencesData: () => ({ blockedUsers: [] }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (o) => ({
  ...(await o<object>()),
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/Collections/collection.utils', async (o) => ({
  ...(await o<object>()),
  useCollection: () => ({ collection: undefined, isLoading: false }),
}));

const FEED = [101, 102, 103, 104];
const SOURCE = 555;

const layout = document.createElement('style');
layout.textContent = `
.flex{display:flex}.flex-1{flex:1 1 0%}.min-h-0{min-height:0}.h-full{height:100%}
.items-stretch{align-items:stretch}.justify-stretch{justify-content:stretch}
.overflow-hidden{overflow:hidden}.relative{position:relative}
.flex-\\[0_0_100\\%\\]{flex:0 0 100%;min-width:0}
`;
document.head.appendChild(layout);

const mounted = vi.hoisted(() => ({ count: 0 }));

/** ImageDetail2's carousel wiring, around the real provider. */
function Detail() {
  useEffect(() => {
    mounted.count += 1;
  }, []);
  const { images, index, navigate } = useImageDetailContext();
  const carouselNavigation = useCarouselNavigation({ items: images, initialIndex: index });
  const handleSettle = useCarouselUrlSync({
    images,
    index,
    navigate,
    carouselNavigate: carouselNavigation.navigate,
  });
  return (
    <div style={{ width: 400, height: 300, display: 'flex' }}>
      <button type="button" data-testid="next" onClick={carouselNavigation.next} />
      <output data-testid="shown">{images[carouselNavigation.index]?.id}</output>
      <ImageDetailCarousel images={images} onSettle={handleSettle} {...carouselNavigation} />
    </div>
  );
}

// The dialog gets its image id from the live route query, as BrowserRouterSync passes it.
function Dialog() {
  const { query } = useBrowserRouter();
  if (!query.imageId) return null;
  return (
    <ImageDetailProvider
      imageId={Number(query.imageId)}
      filters={{}}
      images={FEED.map(image) as never}
    >
      <Detail />
    </ImageDetailProvider>
  );
}

async function openAt(imageId: number) {
  Object.assign(Router, {
    query: { imageId: String(imageId), dialog: 'imageDetail' },
    asPath: `/images/${imageId}`,
    pathname: '/images/[imageId]',
  });
  renderWithProviders(
    <BrowserRouterProvider>
      <Dialog />
    </BrowserRouterProvider>
  );
  // the provider listens for route changes from an effect
  await new Promise((resolve) => setTimeout(resolve, 50));
  getBrowserRouter().replace({ query: { imageId, dialog: 'imageDetail' } }, `/images/${imageId}`);
}

afterEach(() => {
  mounted.count = 0;
  getBrowserRouter().replace({ query: {} }, '/');
});

describe('an open image detail when the route moves to an image from outside it', () => {
  test('shows that image, and stays there', async () => {
    await openAt(FEED[1]);
    await expect.element(page.getByTestId('shown')).toHaveTextContent(String(FEED[1]));

    // the remix card: the source is not in the feed this dialog was opened with
    getBrowserRouter().push(
      { query: { imageId: SOURCE, dialog: ['imageDetail', 'imageDetail'] } },
      `/images/${SOURCE}`
    );

    await expect.element(page.getByTestId('shown')).toHaveTextContent(String(SOURCE));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(location.pathname).toBe(`/images/${SOURCE}`);
    expect(page.getByTestId('shown').element().textContent).toBe(String(SOURCE));
  });

  test('a swipe inside the detail moves the URL without starting it over', async () => {
    await openAt(FEED[1]);
    await expect.element(page.getByTestId('shown')).toHaveTextContent(String(FEED[1]));
    const before = mounted.count;

    await page.getByTestId('next').click();

    await expect.element(page.getByTestId('shown')).toHaveTextContent(String(FEED[2]));
    await vi.waitFor(() => expect(location.pathname).toBe(`/images/${FEED[2]}`));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mounted.count).toBe(before);
  });

  test('going back to the image it started on shows that image', async () => {
    await openAt(FEED[1]);
    await expect.element(page.getByTestId('shown')).toHaveTextContent(String(FEED[1]));
    getBrowserRouter().push(
      { query: { imageId: SOURCE, dialog: ['imageDetail', 'imageDetail'] } },
      `/images/${SOURCE}`
    );
    await expect.element(page.getByTestId('shown')).toHaveTextContent(String(SOURCE));

    getBrowserRouter().push(
      { query: { imageId: FEED[1], dialog: 'imageDetail' } },
      `/images/${FEED[1]}`
    );

    await expect.element(page.getByTestId('shown')).toHaveTextContent(String(FEED[1]));
  });
});
