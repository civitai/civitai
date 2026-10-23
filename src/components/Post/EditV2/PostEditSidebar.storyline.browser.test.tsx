import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type * as NotificationsMod from '@mantine/notifications';
import type { PostDetailEditable } from '~/server/services/post.service';

/**
 * Publishing a post of a storyline: the button says which chapter, and what the server did with the
 * chapter is said once the post is published (see PostEditSidebar.tsx).
 */

const mocks = vi.hoisted(() => ({
  pending: null as unknown,
  mutate: vi.fn(),
  notify: vi.fn(),
  images: [] as unknown[],
  invalidateForPosts: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {
        'storyline.getPendingForPost': {
          useQuery: () => ({ data: mocks.pending, isLoading: false }),
        },
        'post.update': { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
      },
      {
        useUtils: () => ({
          storyline: {
            getForPosts: { invalidate: mocks.invalidateForPosts },
            getPendingForPost: { invalidate: vi.fn() },
          },
          image: { getImagesAsPostsInfinite: { invalidate: vi.fn() } },
        }),
      }
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
      collectionId: undefined,
      collectionTagId: undefined,
      flushPendingSaves: vi.fn(),
    }),
  usePostEditParams: () => ({}),
}));

vi.mock('@mantine/notifications', async (orig) => ({
  ...(await orig<typeof NotificationsMod>()),
  showNotification: mocks.notify,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({ storylines: true, canWrite: true }),
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

const link = (parentChapter: unknown = null) => ({
  postId: 41,
  storyline: { id: 2, title: 'The Patch' },
  parentChapter,
});

beforeEach(() => {
  mocks.pending = null;
  mocks.mutate.mockReset();
  mocks.notify.mockReset();
  mocks.invalidateForPosts.mockReset();
  mocks.images = [
    {
      type: 'added',
      data: {
        id: 1,
        nsfwLevel: 1,
        resourceHelper: [],
        tools: [],
        tags: [],
        meta: {},
        needsReview: null,
      },
    },
  ];
  vi.mocked(useRouter().push).mockClear();
});

describe('the publish button of a storyline post', () => {
  test('a draft of chapter 1 says "Publish chapter 1"', async () => {
    mocks.pending = link();
    renderWithProviders(<PostEditSidebar post={post} />);

    await expect.element(page.getByRole('button', { name: 'Publish chapter 1' })).toBeEnabled();
  });

  test('an ordinary post still says "Publish"', async () => {
    renderWithProviders(<PostEditSidebar post={post} />);

    await expect.element(page.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
    expect(page.getByRole('button', { name: 'Publish chapter 1' }).elements()).toHaveLength(0);
  });

  test('a draft continuing a chapter is not labelled chapter 1', async () => {
    mocks.pending = link({ id: 5, depth: 0, postId: 7 });
    renderWithProviders(<PostEditSidebar post={post} />);

    await expect.element(page.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
    expect(page.getByRole('button', { name: 'Publish chapter 1' }).elements()).toHaveLength(0);
  });
});

describe('after publishing a storyline post', () => {
  async function publishWith(storyline: unknown) {
    mocks.pending = link();
    renderWithProviders(<PostEditSidebar post={post} />);
    await page.getByRole('button', { name: 'Publish chapter 1' }).click();

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    const [, options] = mocks.mutate.mock.calls[0]!;
    await options.onSuccess(storyline === undefined ? undefined : { storyline }, {
      id: 41,
      publishedAt: new Date(),
    });
  }

  test('says the chapter is waiting for the image scan', async () => {
    await publishWith({ storylineId: 2, status: 'waiting', reason: 'notReady' });

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Chapter 1 goes live once your images finish checking.',
        color: 'yellow',
      })
    );
    expect(useRouter().push).toHaveBeenCalled();
  });

  test('says the maximum rating was raised to fit the chapter', async () => {
    await publishWith({
      storylineId: 2,
      status: 'chapterWritten',
      chapterId: 3,
      ceilingRaisedTo: 4,
    });

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "Your storyline's maximum rating was raised to R to fit chapter 1"
        ),
      })
    );
  });

  test('says why a dropped link was not made a chapter', async () => {
    await publishWith({
      storylineId: 2,
      status: 'dropped',
      reason: 'This storyline was taken down',
    });

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'This storyline was taken down', color: 'red' })
    );
  });

  test('refreshes what the storyline pills read', async () => {
    await publishWith({ storylineId: 2, status: 'chapterWritten', chapterId: 3 });

    expect(mocks.invalidateForPosts).toHaveBeenCalled();
  });

  test('an ordinary publish shows no storyline message', async () => {
    mocks.pending = null;
    renderWithProviders(<PostEditSidebar post={post} />);
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    const [, options] = mocks.mutate.mock.calls[0]!;
    await options.onSuccess(undefined, { id: 41, publishedAt: new Date() });

    expect(mocks.notify).not.toHaveBeenCalled();
    expect(useRouter().push).toHaveBeenCalled();
  });
});
