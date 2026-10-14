// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as TrpcModule from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as BrowsingLevelModule from '~/components/BrowsingLevel/BrowsingLevelProvider';
import {
  useStorylineEarlyAccess,
  useStorylineForkShares,
  useStorylineTracking,
} from '~/components/Storyline/storyline.queries';

type MutationOptions = { onSuccess?: (data: unknown, input: never) => unknown };

const mocks = vi.hoisted(() => ({
  storylines: true,
  user: { id: 1 } as { id: number } | null,
  forkSharesQuery: vi.fn(),
  statusQuery: vi.fn(),
  statusData: undefined as { joined: boolean } | undefined,
  // The server's answer to each call: resolve, reject or hold it back per test.
  branchMutate: vi.fn<(input: unknown) => Promise<unknown>>(),
  createMutate: vi.fn<(input: unknown) => Promise<unknown>>(),
  joinMutateAsync: vi.fn<(input: unknown) => Promise<unknown>>(),
  invalidateShares: vi.fn(),
  setStatusData: vi.fn(),
}));

// Each fake mutation runs the hook's own `onSuccess` once the server answer resolves, and never on
// a rejection, as react-query does.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy(
      {
        'storyline.getForkShares': {
          useQuery: (input: unknown, opts: unknown) => {
            mocks.forkSharesQuery(input, opts);
            return { data: undefined };
          },
        },
        'storyline.getEarlyAccessStatus': {
          useQuery: (input: unknown, opts: unknown) => {
            mocks.statusQuery(input, opts);
            return { data: mocks.statusData };
          },
        },
        'storyline.trackBranchChoice': {
          useMutation: (opts?: MutationOptions) => ({
            mutate: (input: never) => {
              mocks.branchMutate(input).then(
                (data) => opts?.onSuccess?.(data, input),
                () => undefined
              );
            },
          }),
        },
        'storyline.trackCreateClick': {
          useMutation: (opts?: MutationOptions) => ({
            mutate: (input: never) => {
              mocks.createMutate(input).then(
                (data) => opts?.onSuccess?.(data, input),
                () => undefined
              );
            },
          }),
        },
        'storyline.joinEarlyAccess': {
          useMutation: (opts?: MutationOptions) => ({
            mutateAsync: async (input: never) => {
              const data = await mocks.joinMutateAsync(input);
              await opts?.onSuccess?.(data, input);
              return data;
            },
            isPending: false,
          }),
        },
      },
      {
        useUtils: () => ({
          storyline: {
            getForkShares: { invalidate: mocks.invalidateShares },
            getEarlyAccessStatus: { setData: mocks.setStatusData },
          },
        }),
      }
    ),
  };
});
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ storylines: mocks.storylines }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelModule>()),
  useViewerBrowsingLevelDebounced: () => 7,
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));

function renderHook<T>(hook: () => T): { current: T } {
  const result = {} as { current: T };
  function Probe() {
    result.current = hook();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => createRoot(container).render(createElement(Probe)));
  return result;
}

beforeEach(() => {
  document.body.innerHTML = '';
  mocks.storylines = true;
  mocks.user = { id: 1 };
  mocks.statusData = undefined;
  mocks.joinMutateAsync.mockReset();
  mocks.joinMutateAsync.mockResolvedValue(undefined);
  mocks.branchMutate.mockReset();
  mocks.branchMutate.mockResolvedValue(undefined);
  mocks.createMutate.mockReset();
  mocks.createMutate.mockResolvedValue(undefined);
  for (const fn of [
    mocks.forkSharesQuery,
    mocks.statusQuery,
    mocks.invalidateShares,
    mocks.setStatusData,
  ])
    fn.mockClear();
});

describe('useStorylineForkShares', () => {
  it('reads the shares for the chapter at the reader browsing level', () => {
    renderHook(() => useStorylineForkShares(4));
    expect(mocks.forkSharesQuery.mock.calls).toEqual([
      [{ chapterId: 4, browsingLevel: 7 }, { enabled: true }],
    ]);
  });

  it('does not read without a chapter', () => {
    renderHook(() => useStorylineForkShares(undefined));
    expect(mocks.forkSharesQuery.mock.calls.map((c) => c[1])).toEqual([{ enabled: false }]);
  });

  it('does not read with the flag off', () => {
    mocks.storylines = false;
    renderHook(() => useStorylineForkShares(4));
    expect(mocks.forkSharesQuery.mock.calls.map((c) => c[1])).toEqual([{ enabled: false }]);
  });
});

describe('useStorylineTracking', () => {
  it('records a signed-in choice with the browsing level', () => {
    const tracking = renderHook(() => useStorylineTracking());
    tracking.current.trackBranchChoice({ fromChapterId: 3, toChapterId: 5 });
    expect(mocks.branchMutate.mock.calls).toEqual([
      [{ fromChapterId: 3, toChapterId: 5, browsingLevel: 7 }],
    ]);
  });

  it('records a signed-in create click with the browsing level', () => {
    const tracking = renderHook(() => useStorylineTracking());
    tracking.current.trackCreateClick({ chapterId: 5 });
    expect(mocks.createMutate.mock.calls).toEqual([[{ chapterId: 5, browsingLevel: 7 }]]);
  });

  // Paired with the two tests above, which prove the same setup does send when signed in.
  it('sends nothing for a signed-out reader, whom the server would refuse', () => {
    mocks.user = null;
    const tracking = renderHook(() => useStorylineTracking());
    tracking.current.trackBranchChoice({ fromChapterId: 3, toChapterId: 5 });
    tracking.current.trackCreateClick({ chapterId: 5 });
    expect([mocks.branchMutate.mock.calls, mocks.createMutate.mock.calls]).toEqual([[], []]);
  });

  // The server drops its cached shares before it answers, so a refresh sent earlier reads stale.
  it('refreshes the shares of the chapter chosen from only once the choice is recorded', async () => {
    let answer!: () => void;
    mocks.branchMutate.mockReturnValueOnce(new Promise<void>((resolve) => (answer = resolve)));
    const tracking = renderHook(() => useStorylineTracking());
    tracking.current.trackBranchChoice({ fromChapterId: 3, toChapterId: 5 });
    await Promise.resolve();
    expect(mocks.invalidateShares.mock.calls).toEqual([]);
    answer();
    await vi.waitFor(() => expect(mocks.invalidateShares.mock.calls).toEqual([[{ chapterId: 3 }]]));
  });

  it('a refused choice refreshes no shares', async () => {
    mocks.branchMutate.mockRejectedValueOnce(new Error('refused'));
    const tracking = renderHook(() => useStorylineTracking());
    tracking.current.trackBranchChoice({ fromChapterId: 3, toChapterId: 5 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.branchMutate).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateShares).not.toHaveBeenCalled();
  });

  it('a create click refreshes no shares', async () => {
    const tracking = renderHook(() => useStorylineTracking());
    tracking.current.trackCreateClick({ chapterId: 5 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.createMutate).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateShares).not.toHaveBeenCalled();
  });
});

describe('useStorylineEarlyAccess', () => {
  it('reads as not joined, and never asks, when signed out', () => {
    mocks.user = null;
    mocks.statusData = { joined: true };
    const access = renderHook(() => useStorylineEarlyAccess());
    expect(mocks.statusQuery.mock.calls.map((c) => c[1])).toEqual([{ enabled: false }]);
    expect(access.current.joined).toBe(false);
  });

  it('reads as not joined, and never asks, with the flag off', () => {
    mocks.storylines = false;
    mocks.statusData = { joined: true };
    const access = renderHook(() => useStorylineEarlyAccess());
    expect(mocks.statusQuery.mock.calls.map((c) => c[1])).toEqual([{ enabled: false }]);
    expect(access.current.joined).toBe(false);
  });

  it('reads the signed-in reader status', () => {
    mocks.statusData = { joined: true };
    const access = renderHook(() => useStorylineEarlyAccess());
    expect(mocks.statusQuery.mock.calls.map((c) => c[1])).toEqual([{ enabled: true }]);
    expect(access.current.joined).toBe(true);
  });

  it('joins for the storyline and stores the reader as joined', async () => {
    const access = renderHook(() => useStorylineEarlyAccess());
    await access.current.join({ storylineId: 9 });
    expect(mocks.joinMutateAsync.mock.calls).toEqual([[{ storylineId: 9 }]]);
    expect(mocks.setStatusData.mock.calls).toEqual([[undefined, { joined: true }]]);
  });

  // The prompt shows "You are on the list" once join resolves, so a failure must reach it.
  it('a failed join rejects and stores nothing', async () => {
    mocks.joinMutateAsync.mockRejectedValueOnce(new Error('refused'));
    const access = renderHook(() => useStorylineEarlyAccess());
    await expect(access.current.join({ storylineId: 9 })).rejects.toThrow('refused');
    expect(mocks.setStatusData).not.toHaveBeenCalled();
  });
});
