import { QueryClient, useQuery } from '@tanstack/react-query';
import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';
import { useReviewFocusStore } from '~/components/Post/EditV2/PostResourceReviews/reviewFocus';
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

const imageWith = (count: number) =>
  ({
    id: 601,
    type: 'image',
    url: 'u',
    name: 'a.png',
    nsfwLevel: 1,
    ingestion: 'Scanned',
    tags: [],
    techniques: [],
    tools: [],
    resourceHelper: Array.from({ length: count }, (_, n) => n + 1).map((modelVersionId) => ({
      modelId: modelVersionId * 10,
      modelVersionId,
      modelName: `Model ${modelVersionId}`,
      modelType: 'LORA',
      detected: true,
    })),
    metadata: { width: 100, height: 100 },
  } as never);

const modelRow = (n: number) => page.getByText(`Model ${n}`, { exact: true });
const showAll = () => page.getByRole('button', { name: /Show All/ });

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
    renderWithProviders(<AddedImage image={imageWith(5)} />);

    await expect.element(modelRow(3)).toBeVisible();
    await expect.element(modelRow(4)).toBeVisible();
    await expect.element(modelRow(5)).not.toBeInTheDocument();

    await showAll().click();
    await expect.element(modelRow(5)).toBeVisible();
  });

  test('a row rated in place stays visible', async () => {
    client.setQueryData(key, [review(1, true), review(2, true), review(3, true), review(4, false)]);
    renderWithProviders(<AddedImage image={imageWith(4)} />);
    await expect.element(modelRow(4)).toBeVisible();

    act(() => {
      client.setQueryData(key, [
        review(1, true),
        review(2, true),
        review(3, true),
        review(4, true),
      ]);
    });
    // the row has re-rendered as rated before we check it is still there
    await expect
      .element(page.getByRole('button', { name: 'Recommend Model 4' }))
      .toHaveAttribute('aria-pressed', 'true');
    await expect.element(modelRow(4)).toBeVisible();
  });

  test('Show All is absent when no rated row is hidden', async () => {
    client.setQueryData(key, [review(1, true), review(2, true), review(3, true), review(4, false)]);
    renderWithProviders(<AddedImage image={imageWith(4)} />);

    await expect.element(modelRow(4)).toBeVisible();
    await expect.element(showAll()).not.toBeInTheDocument();
  });

  test('focusing a hidden rated resource expands the list', async () => {
    client.setQueryData(key, [review(1, true), review(2, true), review(3, true), review(4, true)]);
    renderWithProviders(<AddedImage image={imageWith(4)} />);
    await expect.element(modelRow(4)).not.toBeInTheDocument();
    await expect.element(showAll()).toBeVisible();

    act(() => {
      useReviewFocusStore.setState({ target: { imageId: 601, modelVersionId: 4 } });
    });
    await expect.element(modelRow(4)).toBeVisible();
  });
});
