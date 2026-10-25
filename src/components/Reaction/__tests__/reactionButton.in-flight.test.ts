// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcUtils from '~/utils/trpc';

type MutateOptions = {
  onSuccess?: (r: string) => void;
  onError?: (e: unknown) => void;
  onSettled?: () => void;
};

const mocks = vi.hoisted(() => ({
  mutate: vi.fn<(input: unknown, opts?: MutateOptions) => void>(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcUtils>()),
    trpc: makeTrpcProxy({
      'reaction.toggle': { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
    }),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));

const { ReactionButton } = await import('~/components/Reaction/ReactionButton');

// The reaction store is module scope, so every case takes its own entity id.
function mount(entityId: number) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      // eslint-disable-next-line react/no-children-prop -- ReactionButton's children is a render prop
      createElement(ReactionButton, {
        entityType: 'image',
        entityId,
        reaction: 'Like',
        count: 3,
        children: ({ hasReacted, count }: { hasReacted: boolean; count: number }) =>
          createElement('button', { 'data-reacted': String(hasReacted) }, String(count)),
      })
    );
  });
  const button = () => container.querySelector('button') as HTMLButtonElement;
  const click = () => button().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return { button, click };
}

const lastOptions = () => mocks.mutate.mock.calls.at(-1)?.[1] as MutateOptions;

beforeEach(() => {
  mocks.mutate.mockClear();
});

describe('ReactionButton — one toggle in flight at a time', () => {
  it('two clicks in the same frame send one toggle', () => {
    const { click } = mount(101);
    act(() => {
      click();
      click();
    });
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  // Control: the lock must lift, or the case above passes by disabling the button for good.
  it('a click after the first toggle settles is sent', () => {
    const { click } = mount(102);
    act(() => click());
    act(() => lastOptions().onSettled?.());
    act(() => click());
    expect(mocks.mutate).toHaveBeenCalledTimes(2);
  });

  it('puts the button back when the server ignored the toggle', () => {
    const { click, button } = mount(103);
    act(() => click());
    expect(button().dataset.reacted).toBe('true');

    act(() => {
      lastOptions().onSuccess?.('ignored');
      lastOptions().onSettled?.();
    });
    expect(button().dataset.reacted).toBe('false');
    expect(button().textContent).toBe('3');
  });

  it('keeps the optimistic state when the toggle was applied', () => {
    const { click, button } = mount(104);
    act(() => click());
    act(() => {
      lastOptions().onSuccess?.('created');
      lastOptions().onSettled?.();
    });
    expect(button().dataset.reacted).toBe('true');
    expect(button().textContent).toBe('4');
  });
});
