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

const FEED = [101, 102];
const COMMENT = 777;

function Probe() {
  const { active, toggleInfo } = useImageDetailContext();
  return (
    <>
      <output data-testid="active">{String(active)}</output>
      <button type="button" data-testid="toggle" onClick={toggleInfo} />
    </>
  );
}

function Dialog() {
  const { query } = useBrowserRouter();
  if (!query.imageId) return null;
  return (
    <ImageDetailProvider
      imageId={Number(query.imageId)}
      filters={{}}
      images={FEED.map(image) as never}
    >
      <Probe />
    </ImageDetailProvider>
  );
}

/** Mounts the detail on the route a comment notification links to. */
async function openFromCommentLink() {
  Object.assign(Router, { query: {}, asPath: '/', pathname: '/' });
  renderWithProviders(
    <BrowserRouterProvider>
      <Dialog />
    </BrowserRouterProvider>
  );
  // the provider listens for route changes from an effect
  await new Promise((resolve) => setTimeout(resolve, 50));
  getBrowserRouter().replace(
    { query: { imageId: FEED[0], highlight: COMMENT } },
    `/images/${FEED[0]}?highlight=${COMMENT}`
  );
  await expect.element(page.getByTestId('toggle')).toBeInTheDocument();
}

afterEach(() => {
  vi.restoreAllMocks();
  getBrowserRouter().replace({ query: {} }, '/');
});

describe('image detail opened from a comment notification', () => {
  test('the sheet state reads open', async () => {
    await openFromCommentLink();
    await expect.element(page.getByTestId('active')).toHaveTextContent('true');
  });

  test('one toggle closes it without touching history', async () => {
    await openFromCommentLink();
    const pushState = vi.spyOn(history, 'pushState');
    const go = vi.spyOn(history, 'go');

    await page.getByTestId('toggle').click();

    await expect.element(page.getByTestId('active')).toHaveTextContent('false');
    expect(pushState).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    expect(location.pathname).toBe(`/images/${FEED[0]}`);
  });

  test('with the sheet also expanded in the URL, one toggle still closes it', async () => {
    await openFromCommentLink();
    // A link that carries both, as a reload after expanding the sheet does.
    const router = getBrowserRouter();
    router.push({ query: { ...router.query, active: true } }, router.asPath);
    await vi.waitFor(() => expect(getBrowserRouter().query?.active).toBe(true));

    await page.getByTestId('toggle').click();

    await expect.element(page.getByTestId('active')).toHaveTextContent('false');
  });

  test('moving to another image drops the deep-link open', async () => {
    await openFromCommentLink();
    await expect.element(page.getByTestId('active')).toHaveTextContent('true');

    getBrowserRouter().replace(
      { query: { imageId: FEED[1], highlight: COMMENT } },
      `/images/${FEED[1]}?highlight=${COMMENT}`
    );

    await vi.waitFor(() => expect(location.pathname).toBe(`/images/${FEED[1]}`));
    await expect.element(page.getByTestId('active')).toHaveTextContent('false');
  });
});
