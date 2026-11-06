// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NextRouterModule from 'next/router';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type * as Trpc from '~/utils/trpc';
import type * as Notifications from '~/utils/notifications';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import { NsfwLevel } from '~/server/common/enums';
import { constants } from '~/server/common/constants';

type MutationOptions = {
  onSuccess?: (data: unknown) => void;
  onError?: (error: { message: string }) => void;
};

/**
 * The real data hooks over a stubbed client. Every query answers from `server`, every mutation
 * records its input and answers through `server.mutationResult`, and `useUtils` is one stable set
 * of spies so an invalidate can be counted.
 */
const { server, spies } = vi.hoisted(() => ({
  server: {
    space: undefined as unknown,
    spaceFetching: false,
    storyline: undefined as unknown,
    spaceError: null as { message: string } | null,
    queuePages: [] as { items: unknown[]; nextCursor: string | null }[],
    queueError: null as { message: string } | null,
    hasNextPage: false,
    mine: null as null | { items: { id: number; status: string; awaitingReadiness: boolean }[] },
    mutationResult: { ok: true as boolean, data: undefined as unknown, message: '' },
    myPosts: [] as unknown[],
    defaultPostSort: '' as string,
    chapterPostIds: [] as number[],
  },
  spies: {
    mutate: [] as { proc: string; input: unknown }[],
    invalidate: [] as { path: string; input: unknown }[],
    setData: [] as { path: string; input: unknown; data: unknown }[],
    fetchNextPage: vi.fn(),
    broadInvalidate: vi.fn(),
  },
}));

const mutation = (proc: string) => ({
  useMutation: (hookOptions: MutationOptions = {}) => ({
    isPending: false,
    error: null,
    mutate: (input: unknown, callOptions: MutationOptions = {}) => {
      spies.mutate.push({ proc, input });
      const { ok, data, message } = server.mutationResult;
      for (const options of [hookOptions, callOptions]) {
        if (ok) options.onSuccess?.(data);
        else options.onError?.({ message });
      }
    },
    mutateAsync: async (input: unknown) => {
      spies.mutate.push({ proc, input });
      if (!server.mutationResult.ok) throw new Error(server.mutationResult.message);
      return server.mutationResult.data;
    },
  }),
});

// The continued chapter is a chapter of storyline 3; so are `chapterPostIds`.
const forPosts = (input: { postIds: number[] }) => ({
  data: Object.fromEntries(
    input.postIds
      .filter((id) => id === 200 || server.chapterPostIds.includes(id))
      .map((id) => [id, { chapterId: id, depth: 4, storylineId: 3, title: 'The Patch' }])
  ),
  isLoading: false,
});

const utilsLeaf = (path: string) => ({
  invalidate: async (input?: unknown) => {
    spies.invalidate.push({ path, input });
  },
  setData: (input: unknown, data: unknown) => spies.setData.push({ path, input, data }),
});

// The queue keeps its received/sent tab in the URL; these render it with no Next router mounted.
vi.mock('next/router', async (importOriginal) => ({
  ...(await importOriginal<typeof NextRouterModule>()),
  useRouter: () => ({ query: {}, replace: vi.fn() }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy(
    {
      'placement.getStorylineSpace': {
        useQuery: () => ({
          data: server.space,
          error: server.spaceError,
          isLoading: false,
          isFetching: server.spaceFetching,
        }),
      },
      'storyline.getById': {
        useQuery: () => ({ data: server.storyline, isLoading: false, isError: false }),
      },
      'storyline.update': mutation('storylineUpdate'),
      'storyline.removeCollaborator': mutation('removeCollaborator'),
      'placement.setStorylineSpace': mutation('setStorylineSpace'),
      'placement.submitStorylineContinuation': mutation('submitStorylineContinuation'),
      'placement.actOnStorylineContinuation': mutation('actOnStorylineContinuation'),
      'storyline.addCollaborator': mutation('addCollaborator'),
      'storyline.getForPosts': { useQuery: forPosts },
      // The server's sort filters, from post-sort.ts: a "most" sort lists only posts with at least
      // one of what it counts, and no sort means the default (most reactions).
      'post.getInfinite': {
        useInfiniteQuery: (input: { sort?: string }) => {
          const counted: Record<string, string> = {
            'Most Reactions': 'reactionCount',
            'Most Comments': 'commentCount',
            'Most Collected': 'collectedCount',
          };
          const key = counted[input.sort ?? server.defaultPostSort];
          const items = key
            ? (server.myPosts as Record<string, number>[]).filter((p) => (p[key] ?? 0) > 0)
            : server.myPosts;
          return {
            data: { pages: [{ items, nextCursor: null }] },
            isLoading: false,
            isError: false,
          };
        },
      },
      'placement.getStorylineContinuePrice': {
        useQuery: () => ({
          data: { open: true, price: 0, closedReason: null },
          error: null,
          isLoading: false,
        }),
      },
      'placement.getPendingStorylineContinuations': {
        useInfiniteQuery: () => ({
          data: { pages: server.queuePages },
          error: server.queueError,
          isError: !!server.queueError,
          isLoading: false,
          hasNextPage: server.hasNextPage,
          isFetchingNextPage: false,
          fetchNextPage: spies.fetchNextPage,
        }),
      },
    },
    {
      useQueries: (build: (t: unknown) => unknown[]) =>
        build({ storyline: { getForPosts: forPosts } }),
      useUtils: () => ({
        placement: {
          invalidate: spies.broadInvalidate,
          getStorylineSpace: utilsLeaf('placement.getStorylineSpace'),
          getStorylineContinuePrice: utilsLeaf('placement.getStorylineContinuePrice'),
          getPendingStorylineContinuations: utilsLeaf('placement.getPendingStorylineContinuations'),
        },
        storyline: { invalidate: spies.broadInvalidate, getById: utilsLeaf('storyline.getById') },
        client: {
          placement: {
            getMyStorylineContinuations: {
              query: async () => {
                if (!server.mine) throw new Error('not stubbed');
                return server.mine;
              },
            },
          },
        },
      }),
    }
  ),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1, username: 'owner' }) }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ storylines: true }),
}));
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: () => undefined }),
}));
vi.mock('~/components/Search/QuickSearchDropdown', () => ({ QuickSearchDropdown: () => null }));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showSuccessNotification: () => undefined,
  showErrorNotification: () => undefined,
}));

const data = await import('~/components/Storyline/storyline.data');
const { StorylineContinuationQueue } = await import(
  '~/components/Storyline/queue/StorylineContinuationQueue'
);
const { default: StorylineManageModal } = await import(
  '~/components/Storyline/manage/StorylineManageModal'
);
const { default: StorylineContinueModal } = await import(
  '~/components/Storyline/continue/StorylineContinueModal'
);
const { STORYLINE_REFUSALS } = await import('~/shared/utils/storyline-placement');

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(React.createElement(MantineProvider, null, element));
  });
  return container;
}

function renderHook<T>(useHook: () => T) {
  const result = { current: undefined as T };
  function Probe() {
    result.current = useHook();
    return null;
  }
  render(React.createElement(Probe));
  return result;
}

beforeEach(() => {
  server.space = undefined;
  server.spaceFetching = false;
  server.storyline = undefined;
  server.spaceError = null;
  server.queuePages = [];
  server.queueError = null;
  server.hasNextPage = false;
  server.mine = null;
  server.mutationResult = { ok: true, data: undefined, message: '' };
  server.myPosts = [];
  server.defaultPostSort = constants.postFilterDefaults.sort;
  server.chapterPostIds = [];
  spies.mutate.length = 0;
  spies.invalidate.length = 0;
  spies.setData.length = 0;
  spies.fetchNextPage.mockClear();
  spies.broadInvalidate.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('useStorylineSpace', () => {
  it('reads the price fields and writes the price back with the mode it read', () => {
    server.space = {
      storylineId: 3,
      mode: 'off',
      setPrice: 5,
      price: 5,
      cap: 90,
      inherited: false,
    };
    const saved = { storylineId: 3, mode: 'off', setPrice: 7, price: 7, cap: 90, inherited: false };
    server.mutationResult = { ok: true, data: saved, message: '' };
    const hook = renderHook(() => data.useStorylineSpace(3, { enabled: true }));

    expect(hook.current.data).toEqual({ setPrice: 5, price: 5, cap: 90 });
    act(() => hook.current.save(7));

    // A price change must leave the stored mode as it was; `off` here was set by the owner.
    expect(spies.mutate).toEqual([
      { proc: 'setStorylineSpace', input: { storylineId: 3, mode: 'off', price: 7 } },
    ]);
    expect(spies.setData).toEqual([
      { path: 'placement.getStorylineSpace', input: { storylineId: 3 }, data: saved },
    ]);
  });

  it('withholds the space while it is being re-read, so a save cannot send a stale mode', () => {
    server.space = { storylineId: 3, mode: 'review', setPrice: 5, price: 5, cap: 90 };
    server.spaceFetching = true;
    const hook = renderHook(() => data.useStorylineSpace(3, { enabled: true }));

    expect(hook.current.data).toBeNull();
    act(() => hook.current.save(7));
    expect(spies.mutate).toEqual([]);
  });

  it('writes nothing before the space has been read', () => {
    const hook = renderHook(() => data.useStorylineSpace(3, { enabled: true }));

    act(() => hook.current.save(7));

    expect(spies.mutate).toEqual([]);
  });

  it('reports "not available" for that refusal only', () => {
    server.spaceError = { message: STORYLINE_REFUSALS.notAvailable };
    expect(renderHook(() => data.useStorylineSpace(3, { enabled: true })).current.unavailable).toBe(
      true
    );
  });
});

describe('useSubmitStorylineContinuation', () => {
  const submit = async (awaitingScan: boolean) => {
    const outcomes: string[] = [];
    if (server.mutationResult.ok) server.mutationResult.data = { id: 99 };
    const hook = renderHook(() =>
      data.useSubmitStorylineContinuation({ onSuccess: (outcome) => outcomes.push(outcome) })
    );
    await act(async () => {
      hook.current.mutate({ parentPostId: 9, postId: 4, expectedPrice: 40, awaitingScan });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return outcomes;
  };

  it('sends the shown price and nothing else, and reports what it is waiting on', async () => {
    expect(await submit(true)).toEqual(['awaitingScan']);
    expect(spies.mutate).toEqual([
      {
        proc: 'submitStorylineContinuation',
        input: { parentPostId: 9, postId: 4, expectedPrice: 40 },
      },
    ]);
    act(() => root?.unmount());

    expect(await submit(false)).toEqual(['pending']);
  });

  it('reports the outcome the server recorded, so an endorsed collaborator hears "added"', async () => {
    server.mine = { items: [{ id: 99, status: 'approved', awaitingReadiness: false }] };
    expect(await submit(false)).toEqual(['approved']);
  });

  it('re-reads the price when the refusal says it changed, and not for any other refusal', async () => {
    server.mutationResult = {
      ok: false,
      data: undefined,
      message: `${STORYLINE_REFUSALS.priceChanged}: now 60 Buzz`,
    };
    await submit(false);
    expect(spies.invalidate).toEqual([
      { path: 'placement.getStorylineContinuePrice', input: { parentPostId: 9 } },
    ]);
    act(() => root?.unmount());

    spies.invalidate.length = 0;
    server.mutationResult = { ok: false, data: undefined, message: STORYLINE_REFUSALS.pendingCap };
    await submit(false);
    expect(spies.invalidate).toEqual([]);
  });
});

describe('useStorylineQueue', () => {
  it('flattens every page and says when there are more', () => {
    server.queuePages = [
      { items: [{ id: 1 }], nextCursor: 'a' },
      { items: [{ id: 2 }], nextCursor: null },
    ];
    server.hasNextPage = true;
    const hook = renderHook(() => data.useStorylineQueue({ enabled: true }));

    expect(hook.current.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(hook.current.hasMore).toBe(true);
    hook.current.loadMore();
    expect(spies.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('shows "not available" instead of an error, and a real failure as an error', () => {
    server.queueError = { message: STORYLINE_REFUSALS.notAvailable };
    const notYet = renderHook(() => data.useStorylineQueue({ enabled: true })).current;
    expect([notYet.unavailable, notYet.isError]).toEqual([true, false]);
    act(() => root?.unmount());

    server.queueError = { message: 'Internal server error' };
    const failed = renderHook(() => data.useStorylineQueue({ enabled: true })).current;
    expect([failed.unavailable, failed.isError]).toEqual([false, true]);
  });
});

describe('StorylineContinuationQueue after a decision', () => {
  it('refreshes the queue and that storyline only', async () => {
    server.queuePages = [
      {
        items: [
          {
            id: 1,
            amount: 0,
            createdAt: new Date(),
            expiresAt: null,
            placer: { id: 50, username: 'tehalex', image: null },
            post: { id: 101, title: 'Next', nsfwLevel: NsfwLevel.PG, coverImage: null },
            parentPost: { id: 200, title: 'Chapter 4', nsfwLevel: NsfwLevel.PG, coverImage: null },
            storyline: { id: 7, title: 'The Patch', maxNsfwLevel: NsfwLevel.PG13 },
          },
        ],
        nextCursor: null,
      },
    ];
    const el = render(React.createElement(StorylineContinuationQueue));
    const accept = [...el.querySelectorAll('button')].find((n) => n.textContent === 'Accept');
    expect(accept).toBeTruthy();

    await act(async () => {
      (accept as HTMLButtonElement).click();
    });

    expect(spies.mutate).toEqual([
      { proc: 'actOnStorylineContinuation', input: { placementId: 1, action: 'approve' } },
    ]);
    expect(spies.invalidate).toEqual([
      { path: 'placement.getPendingStorylineContinuations', input: undefined },
      { path: 'storyline.getById', input: { id: 7 } },
    ]);
    expect(spies.broadInvalidate).not.toHaveBeenCalled();
  });
});

describe('StorylineManageModal status change', () => {
  it('re-reads the space after a status change, which decides whether it takes continuations', async () => {
    server.storyline = {
      id: 3,
      userId: 1,
      title: 'The Patch',
      status: 'Ongoing',
      maxNsfwLevel: NsfwLevel.PG13,
      whoCanContinue: 'Anyone',
      collaborators: [],
    };
    server.space = { storylineId: 3, mode: 'review', setPrice: 5, price: 5, cap: 90 };
    render(React.createElement(StorylineManageModal, { storylineId: 3 }));

    const status = document.body.querySelector('[aria-label="Status"]');
    expect(status, 'status control rendered').not.toBeNull();
    const complete = [...(status as Element).querySelectorAll('label')].find(
      (node) => node.textContent?.trim() === 'Complete'
    );
    const input = document.getElementById((complete as HTMLLabelElement).htmlFor);
    expect(input, 'Complete option').not.toBeNull();
    await act(async () => {
      (input as HTMLInputElement).click();
    });

    expect(spies.mutate).toEqual([
      { proc: 'storylineUpdate', input: { id: 3, status: 'Complete' } },
    ]);
    const tab = [...document.body.querySelectorAll('[role="tab"]')].find((node) =>
      node.textContent?.includes('Collaborators')
    );
    expect(tab?.textContent?.trim()).toBe('Collaborators');
    expect(spies.invalidate).toContainEqual({
      path: 'placement.getStorylineSpace',
      input: { storylineId: 3 },
    });
  });
});

describe('StorylineManageModal price', () => {
  it('replaces the slider with a note when the space read refuses the storyline', () => {
    server.storyline = {
      id: 3,
      userId: 1,
      title: 'The Patch',
      status: 'Ongoing',
      maxNsfwLevel: NsfwLevel.PG13,
      whoCanContinue: 'Anyone',
      collaborators: [],
    };
    server.spaceError = { message: STORYLINE_REFUSALS.notAvailable };
    render(React.createElement(StorylineManageModal, { storylineId: 3 }));

    expect(document.body.textContent).toContain('The price is not available yet.');
    expect(document.body.querySelector('[role="slider"]')).toBeNull();
  });
});

describe('StorylineManageModal title', () => {
  it("leads with the storyline's card picture from its read", () => {
    server.storyline = {
      id: 3,
      userId: 1,
      title: 'The Patch',
      status: 'Ongoing',
      maxNsfwLevel: NsfwLevel.PG13,
      whoCanContinue: 'Anyone',
      collaborators: [],
      coverImage: null,
    };
    render(React.createElement(StorylineManageModal, { storylineId: 3 }));

    const title = document.body.querySelector('.mantine-Modal-title') as HTMLElement;
    expect(title.textContent).toBe('Manage The Patch');
    // No picture that may be shown: the 3:4 placeholder, not a skeleton waiting on a query.
    expect(title.querySelector('.aspect-\\[3\\/4\\]')).not.toBeNull();
    expect(title.querySelector('.mantine-Skeleton-root')).toBeNull();
  });
});

describe('StorylineContinueModal post picker', () => {
  const post = (id: number) => ({
    id,
    title: `Post ${id}`,
    nsfwLevel: NsfwLevel.PG,
    publishedAt: null,
    imageCount: 1,
    user: { id: 1 },
    images: [],
  });

  it("leaves out the viewer's posts that are already chapters, and says how many", () => {
    server.storyline = {
      id: 3,
      userId: 9,
      title: 'The Patch',
      status: 'Ongoing',
      maxNsfwLevel: NsfwLevel.PG13,
      whoCanContinue: 'Anyone',
      collaborators: [],
      coverImage: null,
    };
    server.myPosts = [post(11), post(12), post(13)];
    server.chapterPostIds = [12, 13];
    render(React.createElement(StorylineContinueModal, { parentPostId: 200 }));

    const tiles = [...document.body.querySelectorAll('[role="radio"]')];
    expect(tiles.map((node) => node.getAttribute('aria-label'))).toEqual(['Post 11, rated PG']);
    expect(document.body.textContent).toContain(
      '2 of your posts are already chapters, so they aren’t listed.'
    );
    // The header cover comes with the storyline read: no image query left to wait on.
    expect(document.body.querySelectorAll('.mantine-Skeleton-root')).toHaveLength(0);
  });

  it('lists a post nobody has reacted to yet, such as the one just made to continue the story', () => {
    server.storyline = {
      id: 3,
      userId: 9,
      title: 'The Patch',
      status: 'Ongoing',
      maxNsfwLevel: NsfwLevel.PG13,
      whoCanContinue: 'Anyone',
      collaborators: [],
      coverImage: null,
    };
    server.myPosts = [
      { ...post(21), reactionCount: 0 },
      { ...post(22), reactionCount: 5 },
    ];
    render(React.createElement(StorylineContinueModal, { parentPostId: 200 }));

    const tiles = [...document.body.querySelectorAll('[role="radio"]')];
    expect(tiles.map((node) => node.getAttribute('aria-label'))).toEqual([
      'Post 21, rated PG',
      'Post 22, rated PG',
    ]);
    expect(document.body.textContent).not.toContain('already chapters');
  });
});

describe('StorylineManageModal who can continue', () => {
  it('shows the stored value and writes a change through storyline.update', async () => {
    server.storyline = {
      id: 3,
      userId: 1,
      title: 'The Patch',
      status: 'Ongoing',
      maxNsfwLevel: NsfwLevel.PG13,
      whoCanContinue: 'Collaborators',
      collaborators: [],
    };
    render(React.createElement(StorylineManageModal, { storylineId: 3 }));

    const control = document.body.querySelector('[aria-label="Who can continue"]');
    expect(control, 'who-can-continue control').not.toBeNull();
    const inputFor = (label: string) => {
      const labelEl = [...(control as Element).querySelectorAll('label')].find(
        (node) => node.textContent?.trim() === label
      );
      return document.getElementById((labelEl as HTMLLabelElement).htmlFor) as HTMLInputElement;
    };
    expect(inputFor('Only collaborators').checked).toBe(true);
    expect(inputFor('Anyone, I review first').disabled).toBe(false);

    await act(async () => {
      inputFor('Anyone, I review first').click();
    });

    expect(spies.mutate).toEqual([
      { proc: 'storylineUpdate', input: { id: 3, whoCanContinue: 'Anyone' } },
    ]);
  });
});

describe('readSubmitOutcome', () => {
  const mine =
    (items: { id: number; status: string; awaitingReadiness: boolean }[]) => async () => ({
      items,
    });

  it("reports an endorsed collaborator's continuation as approved", async () => {
    expect(
      await data.readSubmitOutcome(
        99,
        false,
        mine([{ id: 99, status: 'approved', awaitingReadiness: false }])
      )
    ).toBe('approved');
  });

  it('reports pending, or waiting for a rating, for anyone else', async () => {
    expect(
      await data.readSubmitOutcome(
        99,
        false,
        mine([{ id: 99, status: 'pending', awaitingReadiness: false }])
      )
    ).toBe('pending');
    expect(
      await data.readSubmitOutcome(
        99,
        false,
        mine([{ id: 99, status: 'pending', awaitingReadiness: true }])
      )
    ).toBe('awaitingScan');
  });

  it('falls back to what it knew when the row is missing or the read fails', async () => {
    expect(
      await data.readSubmitOutcome(
        99,
        true,
        mine([{ id: 1, status: 'approved', awaitingReadiness: false }])
      )
    ).toBe('awaitingScan');
    expect(
      await data.readSubmitOutcome(99, false, async () => {
        throw new Error('down');
      })
    ).toBe('pending');
  });
});

describe('StorylineManageModal collaborators count', () => {
  it('shows a two-digit count as a pill, not a one-character disc', async () => {
    server.storyline = {
      id: 3,
      userId: 1,
      title: 'The Patch',
      status: 'Ongoing',
      maxNsfwLevel: NsfwLevel.PG13,
      whoCanContinue: 'Anyone',
      collaborators: Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, username: `u${i}` })),
    };
    render(React.createElement(StorylineManageModal, { storylineId: 3 }));

    const tab = [...document.body.querySelectorAll('[role="tab"]')].find((node) =>
      node.textContent?.includes('Collaborators')
    );
    expect(tab?.textContent?.trim()).toBe('Collaborators12');
    expect(tab?.querySelector('[data-circle]')).toBeNull();
  });
});
