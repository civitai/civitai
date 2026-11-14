import Router from 'next/router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import {
  BrowserRouterProvider,
  getBrowserRouter,
  useBrowserRouter,
} from '~/components/BrowserRouter/BrowserRouterProvider';
import type { DetailText } from '~/components/Image/Detail/detail-items';
import {
  ImageDetailProvider,
  useImageDetailContext,
} from '~/components/Image/Detail/ImageDetailProvider';
import { ImageDetailCarousel } from '~/components/Image/DetailV2/ImageDetailCarousel';
import { useCarouselUrlSync } from '~/components/Image/DetailV2/useCarouselUrlSync';
import { useCarouselNavigation } from '~/hooks/useCarouselNavigation';
import { renderWithProviders } from '../../../../test/component-setup';

const POST = 40;
const image = (id: number, index: number) => ({
  id,
  postId: POST,
  index,
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
const IMAGES = [image(101, 0), image(102, 1), image(103, 2)];
// Text 7 took image 101's index, so it reads between 101 and 102.
const TEXT = { id: 7, index: 0, content: '<p>Meanwhile</p>', nsfwLevel: 1 };

const { flags, calls, chapters } = vi.hoisted(() => ({
  flags: { storylines: true, storylineText: true } as Record<string, boolean>,
  calls: { postGet: [] as boolean[], getForPosts: [] as boolean[] },
  chapters: { value: {} as Record<number, unknown> },
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy({
    'image.get': {
      useQuery: () => ({ data: undefined, isLoading: false, isInitialLoading: false }),
    },
    // Record whether each read was switched on: a disabled observer fires no request.
    'storyline.getForPosts': {
      useQuery: (_input: unknown, opts?: { enabled?: boolean }) => {
        calls.getForPosts.push(opts?.enabled !== false);
        return { data: opts?.enabled === false ? undefined : chapters.value };
      },
    },
    'post.get': {
      useQuery: ({ id }: { id: number }, opts?: { enabled?: boolean }) => {
        calls.postGet.push(opts?.enabled !== false);
        return { data: opts?.enabled === false ? undefined : { id, texts: [TEXT] } };
      },
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
  useFeatureFlags: () => flags,
}));
vi.mock('~/components/Storyline/storyline.queries', async (o) => ({
  ...(await o<object>()),
  useStorylinesEnabled: () => true,
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
  useViewerBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/Collections/collection.utils', async (o) => ({
  ...(await o<object>()),
  useCollection: () => ({ collection: undefined, isLoading: false }),
}));

/** ImageDetail2's carousel wiring, around the real provider. */
function Detail() {
  const { items, index, navigateTo } = useImageDetailContext();
  const carouselNavigation = useCarouselNavigation({ items, initialIndex: index });
  const handleSettle = useCarouselUrlSync({
    items,
    index,
    navigate: navigateTo,
    carouselNavigate: carouselNavigation.navigate,
  });
  return (
    <div style={{ width: 400, height: 300, display: 'flex' }}>
      <button type="button" data-testid="next" onClick={carouselNavigation.next} />
      <output data-testid="shown">{items[carouselNavigation.index]?.key}</output>
      <output data-testid="items">{items.map((item) => item.key).join(',')}</output>
      <ImageDetailCarousel
        images={IMAGES}
        items={items}
        onSettle={handleSettle}
        {...carouselNavigation}
      />
    </div>
  );
}

function Dialog({ texts }: { texts?: DetailText[] }) {
  const { query } = useBrowserRouter();
  if (!query.imageId) return null;
  return (
    <ImageDetailProvider
      imageId={Number(query.imageId)}
      filters={{ postId: POST }}
      images={IMAGES as never}
      texts={texts}
    >
      <Detail />
    </ImageDetailProvider>
  );
}

async function openAt(
  imageId: number,
  { text, texts }: { text?: number; texts?: DetailText[] } = {}
) {
  const search = text ? `?text=${text}` : '';
  const query = { imageId: String(imageId), dialog: 'imageDetail', ...(text ? { text } : {}) };
  Object.assign(Router, {
    query,
    asPath: `/images/${imageId}${search}`,
    pathname: '/images/[imageId]',
  });
  renderWithProviders(
    <BrowserRouterProvider>
      <Dialog texts={texts} />
    </BrowserRouterProvider>
  );
  // The router provider subscribes from an effect, so a replace before it has does nothing:
  // repeat the (idempotent) replace until the dialog has the route.
  await vi.waitFor(() => {
    getBrowserRouter().replace({ query }, `/images/${imageId}${search}`);
    expect(page.getByTestId('shown').query()).not.toBeNull();
  });
}

const shown = () => page.getByTestId('shown');
const textOfPost = { ...TEXT, postId: POST };

beforeEach(() => {
  flags.storylineText = true;
  chapters.value = { [POST]: { chapterId: 1 } };
  calls.postGet.length = 0;
  calls.getForPosts.length = 0;
});
afterEach(() => {
  getBrowserRouter().replace({ query: {} }, '/');
});

describe('text slides in the image detail carousel', () => {
  test('swiping reads image, text, image, and the text slide has its own URL', async () => {
    await openAt(101, { texts: [textOfPost] });
    await expect.element(shown()).toHaveTextContent('img:101');

    await page.getByTestId('next').click();
    await expect.element(shown()).toHaveTextContent('txt:7');
    await vi.waitFor(() => expect(location.pathname + location.search).toBe('/images/101?text=7'));

    await page.getByTestId('next').click();
    await expect.element(shown()).toHaveTextContent('img:102');
    await vi.waitFor(() => expect(location.pathname + location.search).toBe('/images/102'));
  });

  test("a text slide's URL reopens it", async () => {
    await openAt(101, { text: 7, texts: [textOfPost] });
    await expect.element(shown()).toHaveTextContent('txt:7');
  });

  test('an unknown text id opens the image the URL names', async () => {
    await openAt(101, { text: 99, texts: [textOfPost] });
    await expect.element(shown()).toHaveTextContent('img:101');
  });

  test("a chapter post's viewer reads the post's own texts", async () => {
    await openAt(101);
    await expect
      .element(page.getByTestId('items'))
      .toHaveTextContent('img:101,txt:7,img:102,img:103');
  });

  test('with the flag off nothing changes: the images alone, the same URLs, no extra read', async () => {
    flags.storylineText = false;
    await openAt(101);
    await expect.element(page.getByTestId('items')).toHaveTextContent('img:101,img:102,img:103');
    await page.getByTestId('next').click();
    await vi.waitFor(() => expect(location.pathname + location.search).toBe('/images/102'));
    expect(calls.getForPosts).not.toContain(true);
    expect(calls.postGet).not.toContain(true);
  });

  test('a post that is not a chapter makes no post read', async () => {
    chapters.value = {};
    await openAt(101);
    await expect.element(page.getByTestId('items')).toHaveTextContent('img:101,img:102,img:103');
    expect(calls.getForPosts).toContain(true);
    expect(calls.postGet).not.toContain(true);
  });
});
