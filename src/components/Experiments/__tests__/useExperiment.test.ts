// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

const state = vi.hoisted(() => ({
  user: { id: 501 } as { id: number } | null,
  data: undefined as Record<string, { variant: string; assignment: string }> | undefined,
  isError: false,
  enabled: [] as boolean[],
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.user }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  // eslint-disable-next-line local-rules/no-hand-enumerated-trpc-mock -- the hook makes one query, and the stub must see whether it was enabled
  trpc: {
    experiments: {
      getAssignments: {
        useQuery: (_input: unknown, opts: { enabled: boolean }) => {
          state.enabled.push(opts.enabled);
          return { data: opts.enabled ? state.data : undefined, isError: state.isError };
        },
      },
    },
  },
}));

import { resetFrozenExperimentsForTests, useExperiment } from '../useExperiment';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderHook<T>(useHook: () => T) {
  const result = { current: undefined as T };
  const root = createRoot(document.createElement('div'));
  const Probe = () => {
    result.current = useHook();
    return null;
  };
  act(() => root.render(createElement(Probe)));
  return { result, rerender: () => act(() => root.render(createElement(Probe))) };
}

const assigned = (variant: string) => ({
  hatTurfFeedCard: { variant, assignment: 'rule' },
  hatTurfImageDetail: { variant: 'control', assignment: 'rule' },
});

describe('useExperiment', () => {
  beforeEach(() => {
    resetFrozenExperimentsForTests();
    state.user = { id: 501 };
    state.data = undefined;
    state.enabled = [];
    state.isError = false;
  });

  it.each([
    [
      'the server does not know the experiment',
      { hatTurfImageDetail: { variant: 'control', assignment: 'rule' } },
      false,
    ],
    ['the request failed', undefined, true],
  ])('falls back to the default arm when %s', (_label, data, isError) => {
    state.data = data;
    state.isError = isError;
    const { result } = renderHook(() => useExperiment('hatTurfFeedCard'));
    expect(result.current).toEqual({ ready: true, variant: 'control', assignment: 'unavailable' });
  });

  it('is not ready for a signed-in viewer until the assignment arrives', () => {
    const { result, rerender } = renderHook(() => useExperiment('hatTurfFeedCard'));
    expect(result.current).toEqual({ ready: false, variant: undefined, assignment: undefined });
    state.data = assigned('badge-popover');
    rerender();
    expect(result.current).toEqual({ ready: true, variant: 'badge-popover', assignment: 'rule' });
  });

  it('keeps the first arm for the life of the tab when a refetch answers differently', () => {
    state.data = assigned('badge-popover');
    const { result, rerender } = renderHook(() => useExperiment('hatTurfFeedCard'));
    state.data = assigned('control');
    rerender();
    expect(result.current.variant).toBe('badge-popover');
    // A component mounted later on the same page sees the same arm.
    expect(renderHook(() => useExperiment('hatTurfFeedCard')).result.current.variant).toBe(
      'badge-popover'
    );
  });

  it('does not carry one account’s arm over to another on the same tab', () => {
    state.data = assigned('badge-popover');
    renderHook(() => useExperiment('hatTurfFeedCard'));
    state.user = { id: 502 };
    state.data = assigned('control');
    expect(renderHook(() => useExperiment('hatTurfFeedCard')).result.current.variant).toBe(
      'control'
    );
  });

  it('gives a signed-out viewer the default arm without asking the server', () => {
    state.user = null;
    state.data = assigned('badge-popover');
    const { result } = renderHook(() => useExperiment('hatTurfFeedCard'));
    expect(result.current).toEqual({ ready: true, variant: 'control', assignment: 'signed-out' });
    expect(state.enabled.every((e) => e === false)).toBe(true);
  });

  it('disabled, stays not ready and asks the server nothing, signed in or out', () => {
    state.data = assigned('badge-popover');
    expect(
      renderHook(() => useExperiment('hatTurfFeedCard', { enabled: false })).result.current
    ).toEqual({ ready: false, variant: undefined, assignment: undefined });
    state.user = null;
    expect(
      renderHook(() => useExperiment('hatTurfFeedCard', { enabled: false })).result.current.ready
    ).toBe(false);
    expect(state.enabled.every((e) => e === false)).toBe(true);
  });
});
