import { QueryClient, useQuery } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';
import { renderWithProviders } from '../../../../../test/component-setup';

const openStepper = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({ images: [] as unknown[] }));

const storeImage = (id: number, modelVersionIds: number[]) => ({
  type: 'added',
  data: {
    id,
    index: id,
    url: `u${id}`,
    type: 'image',
    resourceHelper: modelVersionIds.map((modelVersionId) => ({ modelVersionId })),
  },
});

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7, muted: false }) }));
vi.mock('~/components/Post/EditV2/PostEditProvider', () => ({
  usePostEditStore: (select: (s: { images: unknown[] }) => unknown) =>
    select({ images: store.images }),
}));
vi.mock('~/components/Post/EditV2/PostResourceReviews/openResourceReviewStepper', () => ({
  openResourceReviewStepper: openStepper,
}));

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const key = ['post.getResources', 1];

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy(
    {
      'post.getResources': {
        useQuery: (_input: unknown, opts: object) =>
          useQuery({ queryKey: key, queryFn: async () => [], ...opts }, client),
      },
      'resourceReview.upsert': { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    { useUtils: () => ({}) }
  ),
}));

import { ResourceReviewEditButton } from '~/components/Post/EditV2/PostResourceReviews/ResourceReviewEditButton';

beforeEach(() => {
  openStepper.mockReset();
  // Image 3 has no resources of its own: the pencil used to drop images like it.
  store.images = [storeImage(1, [5]), storeImage(2, [5, 6]), storeImage(3, [])];
  client.setQueryData(key, [
    { modelVersionId: 5, modelName: 'Model 5', reviewId: null, reviewRecommended: null },
  ]);
});

describe('ResourceReviewEditButton', () => {
  test('opens the stepper with every image of the post, not just the row owner and its siblings', async () => {
    await renderWithProviders(
      <ResourceReviewEditButton postId={1} ownerId={7} modelVersionId={5} modelName="Model 5" />
    );
    await page.getByRole('button', { name: 'Write a review of Model 5' }).click();
    expect(openStepper).toHaveBeenCalledWith({
      postId: 1,
      ownerId: 7,
      modelVersionId: 5,
      images: [
        { id: 1, url: 'u1', type: 'image', modelVersionIds: [5] },
        { id: 2, url: 'u2', type: 'image', modelVersionIds: [5, 6] },
        { id: 3, url: 'u3', type: 'image', modelVersionIds: [] },
      ],
    });
  });
});
