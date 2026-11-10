import { QueryClient, useQuery } from '@tanstack/react-query';
import type * as NotificationsModule from '~/utils/notifications';
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
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showErrorNotification: vi.fn(),
}));
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

  test('"Next unrated" scrolls the page container so the image lands just below the sticky sub-nav', async () => {
    await renderWithProviders(
      <>
        <div
          className="scroll-area"
          style={{ height: 300, overflow: 'auto', position: 'relative' }}
        >
          <div data-subnav="" style={{ position: 'sticky', top: 0, height: 100 }} />
          <div data-image-id="1" style={{ height: 400 }} />
          <div data-image-id="2" style={{ height: 400 }} />
        </div>
        <ResourceReviewProgressCard postId={1} ownerId={7} />
      </>
    );
    const container = document.querySelector<HTMLElement>('.scroll-area')!;
    const scrollTo = vi.spyOn(container, 'scrollTo').mockImplementation(() => undefined);
    await page.getByRole('button', { name: /Next unrated/ }).click();
    // Image 2 starts 500px into the content; the sub-nav covers the top 100px plus an 8px gap.
    await expect.poll(() => scrollTo.mock.calls.length).toBe(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: 392, behavior: 'smooth' });
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
