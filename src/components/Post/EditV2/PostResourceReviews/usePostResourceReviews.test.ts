// @vitest-environment happy-dom
import { QueryClient, useQuery } from '@tanstack/react-query';
import type * as NotificationsModule from '~/utils/notifications';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

const state = vi.hoisted(() => ({
  currentUser: { id: 7, muted: false } as { id: number; muted: boolean },
}));

const upsert = vi.hoisted(() => vi.fn());
const showErrorNotification = vi.hoisted(() => vi.fn());
const invalidateUserReview = vi.hoisted(() => vi.fn(async () => undefined));
const fetchResources = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({
  images: [] as unknown[],
  set(resources: { modelVersionId: number; name: string }[]) {
    store.images = [{ type: 'added', data: { resourceHelper: resources } }];
  },
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.currentUser }));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showErrorNotification,
}));
vi.mock('~/components/Post/EditV2/PostEditProvider', () => ({
  usePostEditStore: (select: (s: { images: unknown[] }) => unknown) =>
    select({ images: store.images }),
}));

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
  useQuery({ queryKey: key, queryFn: () => fetchResources(), ...opts }, client);
const cached = () =>
  client.getQueryData<ReturnType<typeof row>[]>(key)!.map((r) => r.reviewRecommended);

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy(
    {
      'post.getResources': {
        useQuery: (input: unknown, opts: object) => useResources(input, opts),
      },
      'resourceReview.upsert': { useMutation: () => ({ mutateAsync: upsert }) },
    },
    {
      useUtils: () => ({
        post: {
          getResources: {
            cancel: () => client.cancelQueries({ queryKey: key }),
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

import {
  resetPendingForTests,
  usePostResourceReviews,
  usePostResourceReviewsSync,
} from '~/components/Post/EditV2/PostResourceReviews/usePostResourceReviews';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];
function renderHooks<T>(useHook: () => T, consumers = 1) {
  const results = Array.from({ length: consumers }, () => ({ current: undefined as T }));
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  const Probes = results.map(
    (result) =>
      function Probe() {
        result.current = useHook();
        return null;
      }
  );
  let tick = 0;
  const render = () =>
    act(() =>
      root.render(
        createElement(
          'div',
          null,
          Probes.map((Probe, i) => createElement(Probe, { key: i, tick } as object))
        )
      )
    );
  render();
  return Object.assign(results, {
    rerender: () => {
      tick++;
      render();
    },
  });
}
const useSubject = () => usePostResourceReviews({ postId: 1, ownerId: 7 });
const useSync = () => usePostResourceReviewsSync({ postId: 1, ownerId: 7 });

// Each act() flushes React once, so repeated short waits let a refetch loop show itself.
const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
};
const twoResources = [
  { modelVersionId: 1, name: 'a' },
  { modelVersionId: 2, name: 'b' },
];

beforeEach(() => {
  state.currentUser = { id: 7, muted: false };
  upsert.mockReset();
  showErrorNotification.mockReset();
  client.clear();
  client.setQueryData(key, [row(1), row(2)]);
  fetchResources.mockReset();
  fetchResources.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 10));
    return client.getQueryData(key) ?? [];
  });
  store.set(twoResources);
});

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  resetPendingForTests();
});

describe('usePostResourceReviews', () => {
  it('a rating from one consumer shows in every consumer', async () => {
    upsert.mockResolvedValue({ id: 100, rating: 5, recommended: true });
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
    upsert.mockResolvedValue({ id: 100, rating: 5, recommended: true });
    const [a] = renderHooks(useSubject);
    await act(async () => {
      await a.current.rate(1, true);
    });
    upsert.mockResolvedValue({ id: 100, rating: 1, recommended: false });
    await act(async () => {
      await a.current.rate(1, false);
    });
    expect(upsert.mock.calls[0][0].id).toBeUndefined();
    expect(upsert.mock.calls[1][0]).toMatchObject({ id: 100, rating: 1, recommended: false });
  });

  it('re-applies the rating when a create race returns a review that has another one', async () => {
    upsert
      .mockResolvedValueOnce({ id: 55, rating: 5, recommended: true })
      .mockResolvedValueOnce({ id: 55, rating: 1, recommended: false });
    const [a] = renderHooks(useSubject);
    await act(async () => {
      await a.current.rate(1, false);
    });
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[1][0]).toMatchObject({ id: 55, rating: 1, recommended: false });
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
      resolve({ id: 100, rating: 5, recommended: true });
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

  it('a failed save on one version leaves a concurrent save on another version intact', async () => {
    let failFirst!: (e: Error) => void;
    let resolveSecond!: (v: unknown) => void;
    upsert
      .mockReturnValueOnce(new Promise((_, reject) => (failFirst = reject)))
      .mockReturnValueOnce(new Promise((r) => (resolveSecond = r)));
    const [a] = renderHooks(useSubject);
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(async () => {
      first = a.current.rate(1, true);
      second = a.current.rate(2, false);
    });
    await act(async () => {
      resolveSecond({ id: 200, rating: 1, recommended: false });
      await second;
    });
    await act(async () => {
      failFirst(new Error('nope'));
      await first;
    });
    const rows = client.getQueryData<ReturnType<typeof row>[]>(key)!;
    expect(rows[0]).toMatchObject({ reviewId: null, reviewRecommended: null });
    expect(rows[1]).toMatchObject({ reviewId: 200, reviewRecommended: false, reviewRating: 1 });
    expect(showErrorNotification).toHaveBeenCalledOnce();
  });

  it('re-applies a lost create race when only the rating differs', async () => {
    upsert
      .mockResolvedValueOnce({ id: 55, rating: 3, recommended: true })
      .mockResolvedValueOnce({ id: 55, rating: 5, recommended: true });
    const [a] = renderHooks(useSubject);
    await act(async () => {
      await a.current.rate(1, true);
    });
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('fetches once per set of resources, even when one of them never comes back from the query', async () => {
    const withVae = [...twoResources, { modelVersionId: 3, name: 'vae' }];
    store.set(withVae);
    const hooks = renderHooks(useSync);
    await settle();
    expect(fetchResources).toHaveBeenCalledTimes(1);

    store.set(withVae);
    hooks.rerender();
    await settle();
    expect(fetchResources).toHaveBeenCalledTimes(1);

    store.set([...withVae, { modelVersionId: 4, name: 'd' }]);
    hooks.rerender();
    await settle();
    expect(fetchResources).toHaveBeenCalledTimes(2);
  });

  it('still loads the reviews when a rating lands while the first fetch is in flight', async () => {
    const withThird = [row(1), row(2), row(3)];
    fetchResources.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return withThird;
    });
    upsert.mockResolvedValue({ id: 100, rating: 5, recommended: true });
    const [hook] = renderHooks(() => {
      usePostResourceReviewsSync({ postId: 1, ownerId: 7 });
      return useSubject();
    });
    await act(async () => {
      await hook.current.rate(1, true);
    });
    await settle();
    const rows = client.getQueryData<ReturnType<typeof row>[]>(key)!;
    expect(rows.map((r) => r.modelVersionId)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({ reviewRecommended: true });
  });

  it('marks a version pending as soon as it is rated, even while the first load is in flight', async () => {
    upsert.mockResolvedValue({ id: 100, rating: 5, recommended: true });
    const [hook] = renderHooks(() => {
      usePostResourceReviewsSync({ postId: 1, ownerId: 7 });
      return useSubject();
    });
    let done!: Promise<unknown>;
    await act(async () => {
      done = hook.current.rate(1, true);
    });
    expect(hook.current.isPending(1)).toBe(true);
    await act(async () => {
      await done;
    });
    expect(hook.current.isPending(1)).toBe(false);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('never fetches from a consumer alone', async () => {
    renderHooks(useSubject, 3);
    await settle();
    expect(fetchResources).not.toHaveBeenCalled();
  });

  it('does not fetch for a viewer who cannot review', async () => {
    state.currentUser = { id: 9, muted: false };
    renderHooks(useSync);
    await settle();
    expect(fetchResources).not.toHaveBeenCalled();
  });
});
