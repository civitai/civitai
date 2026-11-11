import { QueryClient, useQuery } from '@tanstack/react-query';
import type * as NotificationsModule from '~/utils/notifications';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';
import { renderWithProviders } from '../../../../../test/component-setup';

const state = vi.hoisted(() => ({
  currentUser: { id: 7, muted: false } as { id: number; muted: boolean },
}));
const upsert = vi.hoisted(() => vi.fn());
const fetchResources = vi.hoisted(() => vi.fn());

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.currentUser }));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showErrorNotification: vi.fn(),
}));
vi.mock('~/components/Post/EditV2/PostEditProvider', () => ({
  usePostEditStore: (select: (s: { images: unknown[] }) => unknown) =>
    select({
      images: [
        { type: 'added', data: { resourceHelper: [{ modelVersionId: 5 }, { modelVersionId: 6 }] } },
      ],
    }),
}));

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const key = ['post.getResources', 1];
const server = vi.hoisted(() => ({ rows: [] as unknown[] }));
const resourceRow = () => ({
  modelVersionId: 5,
  modelId: 50,
  reviewId: null,
  reviewRating: null,
  reviewRecommended: null,
  reviewDetails: null,
  reviewCreatedAt: null,
});

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy(
    {
      'post.getResources': {
        useQuery: (_input: unknown, opts: object) =>
          useQuery(
            {
              queryKey: key,
              queryFn: async () => {
                fetchResources();
                return server.rows;
              },
              ...opts,
            },
            client
          ),
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

import { ResourceReviewThumbs } from '~/components/Post/EditV2/PostResourceReviews/ResourceReviewThumbs';
import {
  PostResourceReviewsSync,
  resetPendingForTests,
} from '~/components/Post/EditV2/PostResourceReviews/usePostResourceReviews';

const Two = () => (
  <>
    <div data-testid="card-a">
      <ResourceReviewThumbs postId={1} ownerId={7} modelVersionId={5} modelName="Cool LoRA" />
    </div>
    <div data-testid="card-b">
      <ResourceReviewThumbs postId={1} ownerId={7} modelVersionId={5} modelName="Cool LoRA" />
    </div>
  </>
);

beforeEach(() => {
  resetPendingForTests();
  fetchResources.mockReset();
  state.currentUser = { id: 7, muted: false };
  server.rows = [resourceRow()];
  client.setQueryData(key, server.rows);
  upsert.mockReset();
  upsert.mockImplementation(async (input: { recommended: boolean; rating: number }) => ({
    id: 99,
    ...input,
    details: null,
  }));
});

describe('ResourceReviewThumbs', () => {
  test('rating a version on one card marks every card that lists it', async () => {
    await renderWithProviders(<Two />);
    const up = page.getByTestId('card-a').getByRole('button', { name: 'Recommend Cool LoRA' });
    await expect.element(up).toHaveAttribute('aria-pressed', 'false');
    await up.click();

    for (const card of ['card-a', 'card-b']) {
      await expect
        .element(page.getByTestId(card).getByRole('button', { name: 'Recommend Cool LoRA' }))
        .toHaveAttribute('aria-pressed', 'true');
      await expect
        .element(page.getByTestId(card).getByRole('button', { name: 'Not for me: Cool LoRA' }))
        .toHaveAttribute('aria-pressed', 'false');
    }
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ modelVersionId: 5, recommended: true })
    );
  });

  test('clicking the already-active thumb does not save again', async () => {
    server.rows = [{ ...resourceRow(), reviewId: 3, reviewRating: 5, reviewRecommended: true }];
    client.setQueryData(key, server.rows);
    await renderWithProviders(<Two />);
    const up = page.getByTestId('card-a').getByRole('button', { name: 'Recommend Cool LoRA' });
    await expect.element(up).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(up);
    expect(upsert).not.toHaveBeenCalled();
  });

  test('renders nothing for a viewer who is not the post owner', async () => {
    state.currentUser = { id: 99, muted: false };
    await renderWithProviders(<Two />);
    expect(page.getByRole('button', { name: /Cool LoRA/ }).elements()).toHaveLength(0);
  });

  test('many cards sharing a post fetch its reviews once', async () => {
    await renderWithProviders(
      <>
        <PostResourceReviewsSync postId={1} ownerId={7} />
        {[5, 6, 5, 6].map((id, i) => (
          <ResourceReviewThumbs
            key={i}
            postId={1}
            ownerId={7}
            modelVersionId={id}
            modelName={`Model ${id}`}
          />
        ))}
      </>
    );
    await expect
      .element(page.getByRole('button', { name: 'Recommend Model 5' }).first())
      .toBeVisible();
    await expect.poll(() => fetchResources.mock.calls.length).toBe(1);
    // A duplicate fetch would be triggered by a later render; give several frames to show one.
    for (let frame = 0; frame < 20; frame++) {
      await new Promise((r) => requestAnimationFrame(r));
      expect(fetchResources).toHaveBeenCalledTimes(1);
    }
  });
});
