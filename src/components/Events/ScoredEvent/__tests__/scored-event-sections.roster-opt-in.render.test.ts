// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EventsUtils from '~/components/Events/events.utils';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

/**
 * The roster choice at join: off unless the viewer ticks it, saved only after the join succeeds, and
 * offered only on an event with a roster. Joined members get their switch in the team panel.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({
  order: [] as string[],
  optIn: vi.fn(),
  activate: vi.fn(),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({ 'event.getCosmetic': { useQuery: () => ({ data: undefined }) } }),
}));
vi.mock('~/components/Events/ScoredEvent/roster/RosterOptIn', () => ({
  RosterOptIn: (props: { compact?: boolean }) =>
    React.createElement('div', { 'data-testid': 'roster-switch', 'data-compact': props.compact }),
  useSetRosterOptIn: () => ({
    mutate: (input: unknown) => {
      calls.order.push('optIn');
      calls.optIn(input);
    },
  }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 9 }) }));
vi.mock('~/hooks/useInView', () => ({
  useInView: () => ({ ref: { current: null }, inView: false }),
}));
vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof EventsUtils>()),
  useTeamColor: () => () => 'pink',
  useMutateEvent: () => ({
    activateCosmetic: async (input: unknown) => {
      calls.order.push('join');
      return calls.activate(input);
    },
    equipping: false,
  }),
}));
vi.mock('~/components/Events/ScoredEvent/event-points-live', () => ({
  useEventTeamsLivePoints: () => undefined,
  MyHatsLivePoints: () => null,
  TopHatsLivePoints: () => null,
}));
type HeroProps = {
  onJoin: () => Promise<void>;
  rosterOnJoin?: { checked: boolean; onChange: (checked: boolean) => void };
  rosterSwitch?: React.ReactNode;
};
let heroProps = {} as HeroProps;
vi.mock('~/components/Events/ScoredEvent/ScoredEventHero', () => ({
  ScoredEventHero: (props: HeroProps) => {
    heroProps = props;
    return props.rosterSwitch ?? null;
  },
}));
vi.mock('~/components/Events/ScoredEvent/HatCatalogPreview', () => ({
  HatCatalogPreview: () => null,
}));
vi.mock('~/components/Events/ScoredEvent/EventRules', () => ({ EventRules: () => null }));

const { ScoredEventSections } = await import('~/components/Events/ScoredEvent/ScoredEventSections');

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => {
  calls.order = [];
  calls.optIn.mockReset();
  calls.activate.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function render(joinable: boolean) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const data = {
    title: 'Birthday',
    joinable,
    startDate: new Date(Date.now() - 60_000),
    endDate: new Date(Date.now() + 60_000),
  } as unknown as React.ComponentProps<typeof ScoredEventSections>['data'];
  act(() =>
    root!.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(ScoredEventSections, { event: 'birthday2026', data })
      )
    )
  );
  return host;
}

async function join() {
  await act(async () => {
    await heroProps.onJoin();
  });
}

describe('ScoredEventSections: roster choice at join', () => {
  it('offers the choice unticked', () => {
    render(true);
    expect(heroProps.rosterOnJoin?.checked).toBe(false);
  });

  it('joins without listing the member when the box is left unticked', async () => {
    render(true);
    await join();
    expect(calls.order).toEqual(['join']);
  });

  it('lists the member after the join succeeds when they ticked the box', async () => {
    render(true);
    act(() => heroProps.rosterOnJoin.onChange(true));
    expect(heroProps.rosterOnJoin.checked).toBe(true);
    await join();
    expect(calls.order).toEqual(['join', 'optIn']);
    expect(calls.optIn).toHaveBeenCalledWith({ event: 'birthday2026', optIn: true });
  });

  it('saves nothing when the join fails', async () => {
    calls.activate.mockRejectedValue(new Error('nope'));
    render(true);
    act(() => heroProps.rosterOnJoin.onChange(true));
    await join();
    expect(calls.order).toEqual(['join']);
  });

  it('offers neither the choice nor the switch on an event without a roster', () => {
    const el = render(false);
    expect(heroProps.rosterOnJoin).toBeUndefined();
    expect(heroProps.rosterSwitch).toBeUndefined();
    expect(el.querySelector('[data-testid="roster-switch"]')).toBeNull();
  });

  it('hands the hero the compact roster switch on an event with a roster', () => {
    const el = render(true);
    expect(el.querySelector('[data-testid="roster-switch"]')?.getAttribute('data-compact')).toBe(
      'true'
    );
  });
});
