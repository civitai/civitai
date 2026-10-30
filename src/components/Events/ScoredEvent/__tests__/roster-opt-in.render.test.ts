// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

/**
 * The viewer's own roster switch: only for a member who joined, showing what they chose, and saving
 * the choice they make.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  joined: true,
  status: undefined as { optedIn: boolean; listedTeam: string | null } | undefined,
  pending: false,
  mutate: vi.fn(),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'event.getCosmetic': { useQuery: () => ({ data: { obtained: state.joined } }) },
    'event.getMyRosterStatus': { useQuery: () => ({ data: state.status }) },
    'event.setRosterOptIn': {
      useMutation: () => ({ mutate: state.mutate, isPending: state.pending }),
    },
  }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 9 }) }));

const { RosterOptIn } = await import('~/components/Events/ScoredEvent/roster/RosterOptIn');

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => {
  state.joined = true;
  state.status = { optedIn: false, listedTeam: null };
  state.pending = false;
  state.mutate.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function render(compact?: boolean) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(RosterOptIn, { event: 'birthday2026', compact })
      )
    )
  );
  return host;
}
const input = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input[type="checkbox"]');

describe('RosterOptIn', () => {
  it('is not offered to a viewer who has not joined', () => {
    state.joined = false;
    expect(input(render())).toBeNull();
  });

  it('shows the saved choice', () => {
    expect(input(render())!.checked).toBe(false);
    act(() => root?.unmount());
    state.status = { optedIn: true, listedTeam: 'Pink' };
    expect(input(render())!.checked).toBe(true);
  });

  it('saves turning it on, and turning it off', () => {
    let el = render();
    act(() => input(el)!.click());
    expect(state.mutate).toHaveBeenLastCalledWith({ event: 'birthday2026', optIn: true });
    act(() => root?.unmount());
    state.status = { optedIn: true, listedTeam: 'Pink' };
    el = render();
    act(() => input(el)!.click());
    expect(state.mutate).toHaveBeenLastCalledWith({ event: 'birthday2026', optIn: false });
  });

  it('cannot be flipped before the saved choice loads, or while saving', () => {
    state.status = undefined;
    expect(input(render())!.disabled).toBe(true);
    act(() => root?.unmount());
    state.status = { optedIn: false, listedTeam: null };
    state.pending = true;
    expect(input(render())!.disabled).toBe(true);
  });

  it('says whether an opted-in member is listed yet, except in its compact form', () => {
    state.status = { optedIn: true, listedTeam: 'Pink' };
    expect(render().textContent).toContain("You're on the roster.");
    act(() => root?.unmount());
    state.status = { optedIn: true, listedTeam: null };
    expect(render().textContent).toContain('Saved. You will appear once');
    act(() => root?.unmount());
    expect(render(true).textContent).not.toContain('Saved.');
    act(() => root?.unmount());
    state.status = { optedIn: true, listedTeam: 'Pink' };
    expect(render(true).textContent).not.toContain('on the roster.');
  });
});
