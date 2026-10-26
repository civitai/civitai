// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcUtils from '~/utils/trpc';

type Row = { id: number; reaction: string; user: { id: number; username: string } };
type Options = {
  onMutate?: (variables: { id: number; reaction: string }) => Promise<unknown>;
  onSuccess?: (result: string, variables: { id: number }, context: unknown) => void;
  onError?: (error: unknown, variables: { id: number }, context: unknown) => void;
  onSettled?: (data: unknown, error: unknown, variables: { id: number; reaction: string }) => void;
};

const h = vi.hoisted(() => ({
  options: undefined as Options | undefined,
  mutate: vi.fn(),
  // The comment.getReactions cache the hook writes to.
  cache: [] as Row[],
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcUtils>()),
    trpc: makeTrpcProxy(
      {
        'comment.toggleReaction': {
          useMutation: (options: Options) => {
            h.options = options;
            return { mutate: h.mutate, isPending: false };
          },
        },
      },
      {
        useUtils: () => ({
          comment: {
            getReactions: {
              cancel: () => Promise.resolve(),
              getData: () => h.cache,
              setData: (_key: unknown, update: Row[] | ((old: Row[]) => Row[])) => {
                h.cache = typeof update === 'function' ? update(h.cache) : update;
              },
            },
          },
        }),
      }
    ),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1, username: 'u' }) }));

const { useToggleCommentReaction } = await import(
  '~/components/CommentSection/useToggleCommentReaction'
);

function mount() {
  let hook: ReturnType<typeof useToggleCommentReaction> | undefined;
  function Probe() {
    hook = useToggleCommentReaction(9);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe)));
  return () => hook as ReturnType<typeof useToggleCommentReaction>;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cache = [];
});

describe('useToggleCommentReaction — one toggle in flight at a time', () => {
  it('two toggles in the same frame send one request', () => {
    const hook = mount();
    act(() => {
      hook().toggle('Like');
      hook().toggle('Like');
    });
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.mutate).toHaveBeenCalledWith({ id: 9, reaction: 'Like' });
  });

  it('a Heart right after a Like is sent too', () => {
    const hook = mount();
    act(() => {
      hook().toggle('Like');
      hook().toggle('Heart');
    });
    expect(h.mutate).toHaveBeenCalledTimes(2);
    expect(h.mutate).toHaveBeenLastCalledWith({ id: 9, reaction: 'Heart' });
  });

  // Control: the lock must lift, or the case above passes by disabling reactions for good.
  it('a toggle after the first settles is sent', () => {
    const hook = mount();
    act(() => hook().toggle('Like'));
    act(() => h.options?.onSettled?.(undefined, null, { id: 9, reaction: 'Like' }));
    act(() => hook().toggle('Like'));
    expect(h.mutate).toHaveBeenCalledTimes(2);
  });

  it('removes its optimistic row when the server ignored the toggle', async () => {
    mount();
    const context = await h.options?.onMutate?.({ id: 9, reaction: 'Like' });
    expect(h.cache.map((r) => r.reaction)).toEqual(['Like']);
    h.options?.onSuccess?.('ignored', { id: 9 }, context);
    expect(h.cache).toEqual([]);
  });

  it('puts back a row it removed when the request failed', async () => {
    mount();
    h.cache = [{ id: 1, reaction: 'Heart', user: { id: 1, username: 'u' } }];
    const context = await h.options?.onMutate?.({ id: 9, reaction: 'Heart' });
    expect(h.cache).toEqual([]);
    h.options?.onError?.(new Error('boom'), { id: 9 }, context);
    expect(h.cache.map((r) => r.reaction)).toEqual(['Heart']);
  });

  it('keeps the optimistic reactions when the toggle was applied', async () => {
    mount();
    const context = await h.options?.onMutate?.({ id: 9, reaction: 'Like' });
    h.options?.onSuccess?.('created', { id: 9 }, context);
    expect(h.cache.map((r) => r.reaction)).toEqual(['Like']);
  });

  it('a failed Like leaves the Heart sent after it alone', async () => {
    mount();
    const like = await h.options?.onMutate?.({ id: 9, reaction: 'Like' });
    const heart = await h.options?.onMutate?.({ id: 9, reaction: 'Heart' });
    h.options?.onError?.(new Error('boom'), { id: 9 }, like);
    expect(h.cache.map((r) => r.reaction)).toEqual(['Heart']);
    h.options?.onError?.(new Error('boom'), { id: 9 }, heart);
    expect(h.cache).toEqual([]);
  });
});
