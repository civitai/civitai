// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcUtils from '~/utils/trpc';

type Options = {
  onSuccess?: (result: string, variables: { id: number }, context: unknown) => void;
  onSettled?: () => void;
};

const h = vi.hoisted(() => ({
  options: undefined as Options | undefined,
  mutate: vi.fn(),
  setData: vi.fn(),
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
      { useUtils: () => ({ comment: { getReactions: { setData: h.setData } } }) }
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

  // Control: the lock must lift, or the case above passes by disabling reactions for good.
  it('a toggle after the first settles is sent', () => {
    const hook = mount();
    act(() => hook().toggle('Like'));
    act(() => h.options?.onSettled?.());
    act(() => hook().toggle('Like'));
    expect(h.mutate).toHaveBeenCalledTimes(2);
  });

  it('restores the previous reactions when the server ignored the toggle', () => {
    mount();
    const previousReactions = [{ id: 1, reaction: 'Heart', user: { id: 2, username: 'x' } }];
    h.options?.onSuccess?.('ignored', { id: 9 }, { previousReactions });
    expect(h.setData).toHaveBeenCalledWith({ commentId: 9 }, previousReactions);
  });

  it('keeps the optimistic reactions when the toggle was applied', () => {
    mount();
    h.options?.onSuccess?.('created', { id: 9 }, { previousReactions: [] });
    expect(h.setData).not.toHaveBeenCalled();
  });
});
