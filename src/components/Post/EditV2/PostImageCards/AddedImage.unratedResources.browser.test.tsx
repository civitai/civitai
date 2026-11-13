import { QueryClient, useQuery } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as TrpcModule from '~/utils/trpc';

/**
 * Resources past the first three collapse behind "Show All", but one the creator has not rated
 * stays expanded so it can be rated in place.
 */

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const key = ['post.getResources', 1];
const review = (modelVersionId: number, rated: boolean) => ({
  modelVersionId,
  modelId: modelVersionId * 10,
  modelName: `Model ${modelVersionId}`,
  reviewId: rated ? modelVersionId : null,
  reviewRating: rated ? 5 : null,
  reviewRecommended: rated ? true : null,
  reviewDetails: null,
  reviewCreatedAt: rated ? new Date() : null,
});

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy(
    {
      'post.getResources': {
        useQuery: (_input: unknown, opts: object) =>
          useQuery({ queryKey: key, queryFn: async () => [], ...opts }, client),
      },
    },
    { useUtils: () => ({}) }
  ),
}));
vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({
      images: [],
      updateImage: vi.fn(),
      setImages: vi.fn(),
      post: { id: 1, user: { id: 9 } },
    }),
  usePostPreviewContext: () => ({ showPreview: false }),
}));
vi.mock('~/hooks/useCurrentUser', async (orig) => ({
  ...(await orig<object>()),
  useCurrentUserRequired: () => ({ id: 9 }),
  useCurrentUser: () => ({ id: 9 }),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', async (orig) => ({
  ...(await orig<object>()),
  EdgeMedia: () => null,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<object>()),
  useFeatureFlags: () => new Proxy({}, { get: () => false }),
}));
vi.mock('~/components/VotableTags/VotableTags', () => ({ VotableTags: () => null }));

// eslint-disable-next-line import/first
import { AddedImage } from '~/components/Post/EditV2/PostImageCards/AddedImage';

const image = {
  id: 601,
  type: 'image',
  url: 'u',
  name: 'a.png',
  nsfwLevel: 1,
  ingestion: 'Scanned',
  tags: [],
  techniques: [],
  tools: [],
  resourceHelper: [1, 2, 3, 4, 5].map((modelVersionId) => ({
    modelId: modelVersionId * 10,
    modelVersionId,
    modelName: `Model ${modelVersionId}`,
    modelType: 'LORA',
    detected: true,
  })),
  metadata: { width: 100, height: 100 },
} as never;

describe('resources collapsed on a post editor image card', () => {
  test('an unrated resource past the limit stays visible; a rated one collapses', async () => {
    // 4 is unrated and 5 is rated, both past the limit of three
    client.setQueryData(key, [
      review(1, true),
      review(2, true),
      review(3, true),
      review(4, false),
      review(5, true),
    ]);
    renderWithProviders(<AddedImage image={image} />);

    await expect.element(page.getByText('Model 3', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Model 4', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Model 5', { exact: true })).not.toBeInTheDocument();

    await page.getByRole('button', { name: /Show All/ }).click();
    await expect.element(page.getByText('Model 5', { exact: true })).toBeVisible();
  });
});
