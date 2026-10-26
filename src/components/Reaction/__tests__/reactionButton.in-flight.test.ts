// @vitest-environment happy-dom
import { act, createElement, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcUtils from '~/utils/trpc';

type Variables = { entityId: number };
type CallbackSet = {
  onSuccess?: (r: string, v: Variables) => void;
  onError?: (e: unknown, v: Variables) => void;
  onSettled?: () => void;
};
type Call = { variables: Variables; settle: (result: string | Error) => void };

// A stand-in for react-query v5 semantics, which the unmount fix relies on: the options given to `useMutation` always run, the callbacks given to
// `mutate` run only while the component that called it is still mounted.
const h = vi.hoisted(() => ({ calls: [] as Call[], options: [] as CallbackSet[] }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcUtils>()),
    trpc: makeTrpcProxy({
      'reaction.toggle': {
        useMutation: (options: CallbackSet = {}) => {
          const mounted = useRef(true);
          useEffect(
            () => () => {
              mounted.current = false;
            },
            []
          );
          const hookOptions = useRef(options);
          hookOptions.current = options;
          h.options.push(options);
          const mutate = (variables: Variables, callOptions: CallbackSet = {}) => {
            h.calls.push({
              variables,
              settle: (result: string | Error) => {
                const o = hookOptions.current;
                if (result instanceof Error) {
                  o.onError?.(result, variables);
                  if (mounted.current) callOptions.onError?.(result, variables);
                } else {
                  o.onSuccess?.(result, variables);
                  if (mounted.current) callOptions.onSuccess?.(result, variables);
                }
                o.onSettled?.();
                if (mounted.current) callOptions.onSettled?.();
              },
            });
          };
          return { mutate, isPending: false };
        },
      },
    }),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));

const { ReactionButton } = await import('~/components/Reaction/ReactionButton');

const settle = (call: Call | undefined, result: string | Error) => call?.settle(result);

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
  const unmount = () => act(() => root.unmount());
  return { button, click, unmount };
}

beforeEach(() => {
  h.calls.length = 0;
  h.options.length = 0;
});

describe('ReactionButton — one toggle in flight at a time', () => {
  it('two clicks in the same frame send one toggle', () => {
    const { click } = mount(101);
    act(() => {
      click();
      click();
    });
    expect(h.calls).toHaveLength(1);
  });

  // Control: the lock must lift, or the case above passes by disabling the button for good.
  it('a click after the first toggle settles is sent', () => {
    const { click } = mount(102);
    act(() => click());
    act(() => settle(h.calls[0], 'created'));
    act(() => click());
    expect(h.calls).toHaveLength(2);
  });

  it('puts the button back when the server ignored the toggle', () => {
    const { click, button } = mount(103);
    act(() => click());
    expect(button().dataset.reacted).toBe('true');

    act(() => settle(h.calls[0], 'ignored'));
    expect(button().dataset.reacted).toBe('false');
    expect(button().textContent).toBe('3');
  });

  it('keeps the optimistic state when the toggle was applied', () => {
    const { click, button } = mount(104);
    act(() => click());
    act(() => settle(h.calls[0], 'created'));
    expect(button().dataset.reacted).toBe('true');
    expect(button().textContent).toBe('4');
  });
});

describe('ReactionButton — shared state and unmounting', () => {
  it('an ignored twin does not undo the reaction the other button created', () => {
    const a = mount(201);
    const b = mount(201);
    act(() => {
      a.click();
      b.click();
    });
    expect(h.calls).toHaveLength(2);
    // The server took the first toggle and ignored the second.
    act(() => {
      settle(h.calls[0], 'created');
      settle(h.calls[1], 'ignored');
    });
    expect(a.button().dataset.reacted).toBe('true');
    expect(b.button().dataset.reacted).toBe('true');
  });

  // The server applies whichever request claims the toggle first, not necessarily the first click.
  it.each([
    ['the twin answers first', true],
    ['the twin answers last', false],
  ])('the second click wins on the server and %s', (_name, twinFirst) => {
    const entityId = twinFirst ? 204 : 205;
    const a = mount(entityId);
    const b = mount(entityId);
    act(() => {
      a.click();
      b.click();
    });
    act(() => {
      if (twinFirst) settle(h.calls[1], 'created');
      settle(h.calls[0], 'ignored');
      if (!twinFirst) settle(h.calls[1], 'created');
    });
    expect(a.button().dataset.reacted).toBe('true');
    expect(b.button().dataset.reacted).toBe('true');
  });

  it('reverts a button that unmounted mid-request when the server ignored it', () => {
    const { click, unmount } = mount(202);
    act(() => click());
    unmount();
    act(() => settle(h.calls[0], 'ignored'));
    // Remount: the store is what a returning button reads.
    const again = mount(202);
    expect(again.button().dataset.reacted).toBe('false');
  });

  it('reverts a button that unmounted mid-request when the request failed', () => {
    const { click, unmount } = mount(203);
    act(() => click());
    unmount();
    act(() => settle(h.calls[0], new Error('boom')));
    expect(mount(203).button().dataset.reacted).toBe('false');
  });
});
