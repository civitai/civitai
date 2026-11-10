// @vitest-environment happy-dom
import { QueryClient, useQuery } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

const state = vi.hoisted(() => ({
  currentUser: { id: 7, muted: false } as { id: number; muted: boolean },
}));

const upsert = vi.hoisted(() => vi.fn());
const showErrorNotification = vi.hoisted(() => vi.fn());
const invalidateUserReview = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.currentUser }));
vi.mock('~/utils/notifications', () => ({ showErrorNotification }));
// Matches the two resources below so the useSubject never refetches over the optimistic cache.
vi.mock('~/components/Post/EditV2/PostEditProvider', () => {
  const images = [
    {
      type: 'added',
      data: {
        resourceHelper: [
          { modelVersionId: 1, name: 'a' },
          { modelVersionId: 2, name: 'b' },
        ],
      },
    },
  ];
  return {
    usePostEditStore: (select: (s: { images: unknown[] }) => unknown) => select({ images }),
  };
});

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const key = ['post.getResources', 1];
const row = (modelVersionId: number, extra = {}) => ({
  modelVersionId,
  modelId: modelVersionId * 10,
  reviewId: null,
  reviewRating: null,
  reviewRecommended: null,
  reviewDetails: null,
  reviewCreatedAt: null,
  ...extra,
});
const useResources = (_input: unknown, opts: object) =>
  useQuery({ queryKey: key, queryFn: () => [], ...opts }, client);
const cached = () =>
  client.getQueryData<ReturnType<typeof row>[]>(key)!.map((r) => r.reviewRecommended);

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy(
    {
      'post.getResources': {
        useQuery: useResources,
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
        resourceReview: { getUserResourceReview: { invalidate: invalidateUserReview } },
      }),
    }
  ),
}));

import { usePostResourceReviews } from '~/components/Post/EditV2/PostResourceReviews/usePostResourceReviews';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderHooks<T>(useHook: () => T, consumers = 1) {
  const results = Array.from({ length: consumers }, () => ({ current: undefined as T }));
  const root = createRoot(document.createElement('div'));
  const probes = results.map((result, i) => {
    function Probe() {
      result.current = useHook();
      return null;
    }
    return createElement(Probe, { key: i });
  });
  act(() => root.render(createElement('div', null, probes)));
  return results;
}
const useSubject = () => usePostResourceReviews({ postId: 1, ownerId: 7 });

beforeEach(() => {
  state.currentUser = { id: 7, muted: false };
  upsert.mockReset();
  showErrorNotification.mockReset();
  client.clear();
  client.setQueryData(key, [row(1), row(2)]);
});

describe('usePostResourceReviews', () => {
  it('a rating from one consumer shows in every consumer', async () => {
    upsert.mockResolvedValue({ id: 100, recommended: true });
    const [a, b] = renderHooks(useSubject, 2);
    await act(async () => {
      await a.current.rate(1, true);
    });
    expect(b.current.byModelVersionId.get(1)?.reviewRecommended).toBe(true);
    expect(b.current.counts).toEqual({ rated: 1, total: 2 });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ postId: 1, modelVersionId: 1, recommended: true, rating: 5 })
    );
  });

  it('rolls back and notifies when the save fails', async () => {
    upsert.mockRejectedValue(new Error('nope'));
    const [a] = renderHooks(useSubject);
    await act(async () => {
      await a.current.rate(1, false);
    });
    expect(cached()).toEqual([null, null]);
    expect(showErrorNotification).toHaveBeenCalledOnce();
  });

  it('updates the created review on the next rating instead of creating again', async () => {
    upsert.mockResolvedValue({ id: 100, recommended: true });
    const [a] = renderHooks(useSubject);
    await act(async () => {
      await a.current.rate(1, true);
    });
    upsert.mockResolvedValue({ id: 100, recommended: false });
    await act(async () => {
      await a.current.rate(1, false);
    });
    expect(upsert.mock.calls[0][0].id).toBeUndefined();
    expect(upsert.mock.calls[1][0]).toMatchObject({ id: 100, recommended: false });
  });

  it('re-applies the rating when a create race returns a review that has another one', async () => {
    upsert
      .mockResolvedValueOnce({ id: 55, recommended: true })
      .mockResolvedValueOnce({ id: 55, recommended: false });
    const [a] = renderHooks(useSubject);
    await act(async () => {
      await a.current.rate(1, false);
    });
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[1][0]).toMatchObject({ id: 55, recommended: false });
  });

  it('ignores a second rating for the same version while one is in flight', async () => {
    let resolve!: (v: unknown) => void;
    upsert.mockReturnValue(new Promise((r) => (resolve = r)));
    const [a] = renderHooks(useSubject);
    let first!: Promise<unknown>;
    act(() => {
      first = a.current.rate(1, true);
    });
    expect(a.current.isPending(1)).toBe(true);
    await act(async () => {
      expect(await a.current.rate(1, false)).toBe('ignored');
    });
    expect(upsert).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ id: 100, recommended: true });
      await first;
    });
    expect(a.current.isPending(1)).toBe(false);
  });

  it('does not create a review from a comment alone', async () => {
    const [a] = renderHooks(useSubject);
    await act(async () => {
      expect(await a.current.saveDetails(1, 'text')).toBe('needs-rating');
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("cannot review as a muted user or on someone else's post", () => {
    state.currentUser = { id: 7, muted: true };
    expect(renderHooks(useSubject)[0].current.canReview).toBe(false);
    state.currentUser = { id: 9, muted: false };
    expect(renderHooks(useSubject)[0].current.canReview).toBe(false);
  });
});
