import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
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
/** The clock button beside Publish (icon only, no accessible name). */
const schedule = () => publish().element().parentElement!.querySelectorAll('button')[1];

beforeEach(() => {
  mocks.collectionId = undefined;
  mocks.images = [];
});

describe('publishing a post with songs from the edit sidebar', () => {
  test('Publish and Schedule are disabled with the reason while a song has no genre', async () => {
    mocks.images = [added(7, 'audio', { genre: 'Pop' }), added(8, 'audio', {})];
    renderWithProviders(<PostEditSidebar post={post} />);

    await expect.element(publish()).toBeDisabled();
    expect(schedule()).toBeDisabled();
    await userEvent.hover(publish().element().parentElement as HTMLElement);
    await expect
      .element(page.getByText('Pick a genre for every song to publish'))
      .toBeInTheDocument();
  });

  test('Publish is enabled once every song has a genre', async () => {
    mocks.images = [added(7, 'audio', { genre: 'Pop' }), added(8, 'audio', { genre: 'Jazz' })];
    renderWithProviders(<PostEditSidebar post={post} />);

    await expect.element(publish()).toBeEnabled();
  });

  test('a post without songs publishes as before', async () => {
    mocks.images = [added(9, 'image', {})];
    renderWithProviders(<PostEditSidebar post={post} />);

    await expect.element(publish()).toBeEnabled();
  });
});
