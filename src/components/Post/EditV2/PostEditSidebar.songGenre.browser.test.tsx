import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type { PostDetailEditable } from '~/server/services/post.service';

/** A post with songs can be published or scheduled only once every song has a genre. */

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
  title: 'Night tape',
  publishedAt: null,
  user: { id: 1 },
  modelVersionId: null,
  parentModelId: null,
} as unknown as PostDetailEditable;

const added = (id: number, type: string, metadata: object) => ({
  type: 'added',
  data: {
    id,
    type,
    metadata,
    nsfwLevel: 1,
    resourceHelper: [],
    tools: [],
    tags: [],
    meta: {},
    needsReview: null,
  },
});

const publish = () => page.getByRole('button', { name: 'Publish', exact: true });
const schedule = () => page.getByRole('button', { name: 'Schedule Publish', exact: true });

beforeEach(() => {
  mocks.collectionId = undefined;
  mocks.images = [];
});

describe('publishing a post with songs from the edit sidebar', () => {
  test('Publish and Schedule are disabled, with the reason written under them, while a song has no genre', async () => {
    mocks.images = [added(7, 'audio', { genre: 'Pop' }), added(8, 'audio', {})];
    renderWithProviders(<PostEditSidebar post={post} />);

    await expect.element(publish()).toBeDisabled();
    await expect.element(schedule()).toBeDisabled();
    // Readable without hover (touch screens).
    await expect.element(page.getByText('Pick a genre for every song to publish')).toBeVisible();
  });

  test('Publish is enabled once every song has a genre', async () => {
    mocks.images = [added(7, 'audio', { genre: 'Pop' }), added(8, 'audio', { genre: 'Jazz' })];
    renderWithProviders(<PostEditSidebar post={post} />);

    await expect.element(publish()).toBeEnabled();
    await expect.element(schedule()).toBeEnabled();
    await expect
      .element(page.getByText('Pick a genre for every song to publish'))
      .not.toBeInTheDocument();
  });

  test('a post without songs publishes as before', async () => {
    mocks.images = [added(9, 'image', {})];
    renderWithProviders(<PostEditSidebar post={post} />);

    await expect.element(publish()).toBeEnabled();
  });

  test('a scheduled post with a genre-less song cannot be rescheduled', async () => {
    mocks.images = [added(8, 'audio', {})];
    const scheduled = { ...post, publishedAt: new Date(Date.now() + 86_400_000) };
    renderWithProviders(<PostEditSidebar post={scheduled as PostDetailEditable} />);

    await expect
      .element(page.getByRole('button', { name: 'Reschedule Publish', exact: true }))
      .toBeDisabled();
  });

  test('a post already public is not blocked by a genre-less song', async () => {
    mocks.images = [added(8, 'audio', {})];
    const published = { ...post, publishedAt: new Date(Date.now() - 86_400_000) };
    renderWithProviders(<PostEditSidebar post={published as PostDetailEditable} />);

    await expect.element(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
    await expect
      .element(page.getByText('Pick a genre for every song to publish'))
      .not.toBeInTheDocument();
  });
});
