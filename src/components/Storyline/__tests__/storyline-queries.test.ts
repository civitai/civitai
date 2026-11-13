// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as TrpcModule from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as BrowsingLevelModule from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as HiddenPreferencesModule from '~/hooks/hidden-preferences';
import {
  useStorylineCanonAhead,
  useStorylineEarlyAccess,
  useStorylineForkShares,
  useStorylinePathLanes,
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
  canonAheadQuery: vi.fn(),
  graphQuery: vi.fn(),
  graphData: undefined as unknown,
  canonAheadData: undefined as unknown[] | undefined,
  canonAheadLoading: false,
  childrenByChapter: {} as Record<number, unknown[]>,
  childrenReads: [] as unknown[],
  hiddenUsers: [] as { id: number }[],
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
        'storyline.getGraph': {
          useQuery: (input: unknown, opts: unknown) => {
            mocks.graphQuery(input, opts);
            return { data: mocks.graphData, isLoading: false };
          },
        },
        'storyline.getCanonAhead': {
          useQuery: (input: unknown, opts: unknown) => {
            mocks.canonAheadQuery(input, opts);
            return { data: mocks.canonAheadData, isLoading: mocks.canonAheadLoading };
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
        useQueries: (
          build: (t: { storyline: { getChildren: (input: unknown) => unknown } }) => unknown[]
        ) => {
          const inputs = build({ storyline: { getChildren: (input) => input } });
          mocks.childrenReads.push(...inputs);
          return inputs.map((input) => {
            const data = mocks.childrenByChapter[(input as { chapterId: number }).chapterId];
            return { data, dataUpdatedAt: data ? 1 : 0 };
          });
        },
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
vi.mock('~/hooks/hidden-preferences', async (importOriginal) => ({
  ...(await importOriginal<typeof HiddenPreferencesModule>()),
  useHiddenPreferencesData: () => ({ hiddenUsers: mocks.hiddenUsers }),
}));

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
  mocks.canonAheadData = undefined;
  mocks.canonAheadLoading = false;
  mocks.childrenByChapter = {};
  mocks.childrenReads = [];
  mocks.hiddenUsers = [];
  mocks.canonAheadQuery.mockClear();
  mocks.graphQuery.mockClear();
  mocks.graphData = undefined;
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

describe('useStorylineCanonAhead', () => {
  const chapter = (chapterId: number, childCount: number, userId = 2) => ({
    chapterId,
    childCount,
    depth: chapterId,
    tombstone: null,
    post: { id: chapterId * 10, userId },
  });

  it('reads the canon line after the chapter in one read, at the reader browsing level', () => {
    mocks.canonAheadData = [chapter(5, 1), chapter(6, 1)];
    const result = renderHook(() => useStorylineCanonAhead(4, { enabled: true }));
    expect(mocks.canonAheadQuery.mock.calls).toEqual([
      [{ chapterId: 4, browsingLevel: 7 }, { enabled: true }],
    ]);
    expect(result.current.ahead.map((c) => c.chapterId)).toEqual([5, 6]);
  });

  it('reads children only for the stops that fork', () => {
    mocks.canonAheadData = [chapter(5, 1), chapter(6, 3), chapter(7, 1), chapter(8, 2)];
    renderHook(() => useStorylineCanonAhead(4, { enabled: true }));
    expect(mocks.childrenReads).toEqual([
      { chapterId: 6, browsingLevel: 7 },
      { chapterId: 8, browsingLevel: 7 },
    ]);
  });

  it("gives each fork stop its children, without a hidden user's branch", () => {
    mocks.canonAheadData = [chapter(5, 3), chapter(6, 1)];
    mocks.hiddenUsers = [{ id: 99 }];
    mocks.childrenByChapter = { 5: [chapter(6, 1), chapter(50, 0), chapter(51, 0, 99)] };
    const result = renderHook(() => useStorylineCanonAhead(4, { enabled: true }));
    const branches = result.current.childrenByChapterId.get(5) ?? [];
    expect([
      [...result.current.childrenByChapterId.keys()],
      branches.map((c) => [c.chapterId, c.tombstone]),
    ]).toEqual([
      [5],
      [
        [6, null],
        [50, null],
        [51, 'unavailable'],
      ],
    ]);
  });

  it('is loading only while the drawer is open and the line is being read', () => {
    mocks.canonAheadLoading = true;
    const open = renderHook(() => useStorylineCanonAhead(4, { enabled: true }));
    const closed = renderHook(() => useStorylineCanonAhead(4, { enabled: false }));
    expect([open.current.isLoading, closed.current.isLoading]).toEqual([true, false]);
  });

  it('reads nothing while the drawer is closed', () => {
    mocks.canonAheadData = [chapter(5, 3)];
    renderHook(() => useStorylineCanonAhead(4, { enabled: false }));
    expect([mocks.canonAheadQuery.mock.calls.map((c) => c[1]), mocks.childrenReads]).toEqual([
      [{ enabled: false }],
      [],
    ]);
  });

  it('hides a canon chapter by a user the reader hid', () => {
    mocks.canonAheadData = [chapter(5, 1, 99)];
    mocks.hiddenUsers = [{ id: 99 }];
    const result = renderHook(() => useStorylineCanonAhead(4, { enabled: true }));
    expect(result.current.ahead.map((c) => [c.chapterId, c.tombstone, c.post])).toEqual([
      [5, 'unavailable', null],
    ]);
  });
});

describe('useStorylinePathLanes', () => {
  // Trunk 1, then a branch 2 -> 3 off it, beside the canon chapter 4.
  const graph = {
    rootChapterId: 1,
    chapters: [1, 2, 3, 4].map((chapterId) => ({
      chapterId,
      depth: 0,
      tombstone: null,
      post: { id: chapterId, title: null, userId: 1, username: 'u' },
    })),
    edges: [
      { chapterId: 4, parentChapterId: 1, canon: true },
      { chapterId: 2, parentChapterId: 1, canon: false },
      { chapterId: 3, parentChapterId: 2, canon: true },
    ],
    truncated: false,
  };
  const main = [
    { chapterId: 1, onMain: true },
    { chapterId: 4, onMain: true },
  ];
  const branch = [
    { chapterId: 1, onMain: true },
    { chapterId: 2, onMain: false },
    { chapterId: 3, onMain: false },
  ];

  it('does not read the graph for a reader on the main route', () => {
    mocks.graphData = graph;
    const lanes = renderHook(() => useStorylinePathLanes(5, main));
    expect(mocks.graphQuery.mock.calls.map((c) => c[1])).toEqual([{ enabled: false }]);
    expect(lanes.current.size).toBe(0);
  });

  it('reads the graph at the reader browsing level once the path leaves the main route', () => {
    mocks.graphData = graph;
    const lanes = renderHook(() => useStorylinePathLanes(5, branch));
    expect(mocks.graphQuery.mock.calls).toEqual([[{ id: 5, browsingLevel: 7 }, { enabled: true }]]);
    expect([...lanes.current]).toEqual([
      [2, 1],
      [3, 1],
    ]);
  });

  it('colours nothing while the graph has not arrived', () => {
    const lanes = renderHook(() => useStorylinePathLanes(5, branch));
    expect(mocks.graphQuery.mock.calls.map((c) => c[1])).toEqual([{ enabled: true }]);
    expect(lanes.current.size).toBe(0);
  });

  it('does not read with the flag off', () => {
    mocks.storylines = false;
    renderHook(() => useStorylinePathLanes(5, branch));
    expect(mocks.graphQuery.mock.calls.map((c) => c[1])).toEqual([{ enabled: false }]);
  });
});
