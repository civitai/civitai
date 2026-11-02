import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type { PostDetailEditable } from '~/server/services/post.service';

/**
 * The sidebar's View Post button always lands on the post page, whatever the image count. A
 * one-image post used to go to the image page, and an image still uploading did nothing at all.
 */

const mocks = vi.hoisted(() => ({
  images: [] as unknown[],
  collectionId: undefined as number | undefined,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {
        'storyline.getPendingForPost': { useQuery: () => ({ data: null, isLoading: false }) },
        'post.update': { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      },
      { useUtils: () => ({ image: { getImagesAsPostsInfinite: { invalidate: vi.fn() } } }) }
    ),
  };
});

vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({
      updatePost: vi.fn(),
      isReordering: false,
      images: mocks.images,
      collectionId: mocks.collectionId,
      collectionTagId: undefined,
      flushPendingSaves: vi.fn(),
    }),
  usePostEditParams: () => ({}),
}));

vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({ canWrite: true }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/hooks/useCatchNavigation', () => ({ useCatchNavigation: () => undefined }));
vi.mock('~/components/Tours/ToursProvider', () => ({
  useTourContext: () => ({ runTour: vi.fn(), running: false }),
}));
vi.mock('~/components/Post/post.utils', () => ({
  usePostContestCollectionDetails: () => ({ collection: undefined }),
}));
vi.mock('~/components/Sticker/PlacementSpaceToggle', () => ({ PlacementSpaceToggle: () => null }));
vi.mock('~/components/Post/EditV2/PostEditApplyPreset', () => ({
  PostEditApplyPreset: () => null,
}));
vi.mock('~/components/Post/EditV2/PostEditModelLink', () => ({ PostEditModelLink: () => null }));
vi.mock('~/components/Post/DeletePostButton', () => ({ DeletePostButton: () => null }));
vi.mock('~/components/ShareButton/ShareButton', () => ({
  ShareButton: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// eslint-disable-next-line import/first
import { PostEditSidebar } from '~/components/Post/EditV2/PostEditSidebar';

const post = {
  id: 41,
  title: 'Cat patch',
  publishedAt: null,
  user: { id: 1 },
  modelVersionId: null,
  parentModelId: null,
} as unknown as PostDetailEditable;

const saved = (id: number) => ({
  type: 'added',
  data: { id, nsfwLevel: 1, resourceHelper: [], tools: [], tags: [], meta: {}, needsReview: null },
});
// Still uploading: no database id yet, and the sidebar counts it like any other image.
const uploading = () => ({
  type: 'resolving',
  data: { url: 'blob:upload', name: 'cat.png', uuid: 'up-1' },
});

const viewPost = () => page.getByRole('button', { name: 'View Post', exact: true });

beforeEach(() => {
  mocks.collectionId = undefined;
  mocks.images = [];
  vi.mocked(useRouter().push).mockClear();
  vi.mocked(useRouter().replace).mockClear();
});

describe('View Post in the edit sidebar', () => {
  test('a one-image post goes to the post page, not the image page', async () => {
    mocks.images = [saved(7)];
    renderWithProviders(<PostEditSidebar post={post} />);

    await viewPost().click();
    expect(useRouter().push).toHaveBeenCalledExactlyOnceWith('/posts/41');
  });

  test('a several-image post goes to the post page (control)', async () => {
    mocks.images = [saved(7), saved(8)];
    renderWithProviders(<PostEditSidebar post={post} />);

    await viewPost().click();
    expect(useRouter().push).toHaveBeenCalledExactlyOnceWith('/posts/41');
  });

  test('a one-image post whose image is still uploading still navigates', async () => {
    mocks.images = [uploading()];
    renderWithProviders(<PostEditSidebar post={post} />);

    await viewPost().click();
    expect(useRouter().push).toHaveBeenCalledExactlyOnceWith('/posts/41');
  });

  test('a collection entry replaces the history entry with the post page', async () => {
    mocks.collectionId = 3;
    mocks.images = [saved(7)];
    renderWithProviders(<PostEditSidebar post={post} />);

    await page.getByRole('button', { name: 'View Entry', exact: true }).click();
    expect(useRouter().replace).toHaveBeenCalledExactlyOnceWith('/posts/41');
    expect(useRouter().push).not.toHaveBeenCalled();
  });
});
