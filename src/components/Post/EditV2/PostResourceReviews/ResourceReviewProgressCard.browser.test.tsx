import { QueryClient, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';
import { renderWithProviders } from '../../../../../test/component-setup';

const state = vi.hoisted(() => ({
  currentUser: { id: 7, muted: false } as { id: number; muted: boolean },
}));
const upsert = vi.hoisted(() => vi.fn());
const openStepper = vi.hoisted(() => vi.fn());

const storeImage = (id: number, modelVersionIds: number[]) => ({
  type: 'added',
  data: {
    id,
    index: id,
    url: `u${id}`,
    type: 'image',
    resourceHelper: modelVersionIds.map((modelVersionId) => ({
      modelVersionId,
      modelName: `Model ${modelVersionId}`,
    })),
  },
});
const store = vi.hoisted(() => ({ images: [] as unknown[] }));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.currentUser }));
vi.mock('~/utils/notifications', () => ({ showErrorNotification: vi.fn() }));
vi.mock('~/components/Post/EditV2/PostEditProvider', () => ({
  usePostEditStore: (select: (s: { images: unknown[] }) => unknown) =>
    select({ images: store.images }),
}));
vi.mock('~/components/Post/EditV2/PostResourceReviews/openResourceReviewStepper', () => ({
  openResourceReviewStepper: openStepper,
}));

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const key = ['post.getResources', 1];
const resourceRow = (modelVersionId: number, rated = false) => ({
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
      'resourceReview.upsert': { useMutation: () => ({ mutateAsync: upsert }) },
    },
    {
      useUtils: () => ({
        post: {
          getResources: {
            cancel: async () => undefined,
            getData: () => client.getQueryData(key),
            setData: (_input: unknown, updater: unknown) =>
              client.setQueryData(
                key,
                typeof updater === 'function' ? updater(client.getQueryData(key)) : updater
              ),
          },
        },
        resourceReview: { getUserResourceReview: { invalidate: async () => undefined } },
      }),
    }
  ),
}));

import { ResourceReviewProgressCard } from '~/components/Post/EditV2/PostResourceReviews/ResourceReviewProgressCard';
import { ResourceReviewThumbs } from '~/components/Post/EditV2/PostResourceReviews/ResourceReviewThumbs';
import { resetPendingForTests } from '~/components/Post/EditV2/PostResourceReviews/usePostResourceReviews';

const card = () => renderWithProviders(<ResourceReviewProgressCard postId={1} ownerId={7} />);

beforeEach(() => {
  resetPendingForTests();
  state.currentUser = { id: 7, muted: false };
  store.images = [storeImage(1, [6]), storeImage(2, [5, 6])];
  client.setQueryData(key, [resourceRow(5), resourceRow(6, true)]);
  upsert.mockReset();
  upsert.mockImplementation(async (input: object) => ({ id: 99, details: null, ...input }));
  openStepper.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe('ResourceReviewProgressCard', () => {
  test('shows how many resources are rated and updates after a rating made elsewhere', async () => {
    await renderWithProviders(
      <>
        <ResourceReviewProgressCard postId={1} ownerId={7} />
        <ResourceReviewThumbs postId={1} ownerId={7} modelVersionId={5} modelName="Model 5" />
      </>
    );
    await expect.element(page.getByText('1 of 2 resources rated')).toBeVisible();
    await page.getByRole('button', { name: 'Recommend Model 5' }).click();
    await expect.element(page.getByText('All resources rated')).toBeVisible();
  });

  test('tells a muted owner they cannot review instead of showing progress', async () => {
    state.currentUser = { id: 7, muted: true };
    await card();
    await expect
      .element(page.getByText('You cannot add reviews because you have been muted'))
      .toBeVisible();
    expect(page.getByText(/resources rated/).elements()).toHaveLength(0);
  });

  test('renders nothing for a viewer who is not the post owner', async () => {
    state.currentUser = { id: 99, muted: false };
    await card();
    expect(page.getByText(/resources? rated|been muted/).elements()).toHaveLength(0);
  });

  test('"Next unrated" scrolls to the first image that uses an unrated resource', async () => {
    const scroll = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => undefined);
    await renderWithProviders(
      <>
        <div data-image-id="1" />
        <div data-image-id="2" />
        <ResourceReviewProgressCard postId={1} ownerId={7} />
      </>
    );
    await page.getByRole('button', { name: /Next unrated/ }).click();
    await expect.poll(() => scroll.mock.contexts.length).toBe(1);
    expect((scroll.mock.contexts[0] as HTMLElement).dataset.imageId).toBe('2');
  });

  test('"Review the rest" opens the stepper with a snapshot of the post images', async () => {
    await card();
    await page.getByRole('button', { name: /Review the rest/ }).click();
    expect(openStepper).toHaveBeenCalledWith({
      postId: 1,
      ownerId: 7,
      images: [
        { id: 1, url: 'u1', type: 'image', modelVersionIds: [6] },
        { id: 2, url: 'u2', type: 'image', modelVersionIds: [5, 6] },
      ],
    });
  });
});
