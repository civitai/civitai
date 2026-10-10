// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as EventsUtils from '~/components/Events/events.utils';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

/**
 * The hat cooldown counts down from when getMyHats answered. The page must hand Your hats the
 * query's own dataUpdatedAt: any other clock reading (render time, 0) shifts or unlocks the wait.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hats = [
  { cosmeticId: 31, claimKey: 'claimed', topicId: 't31', points: 5, moveCooldownLeftMs: 60_000 },
];
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'event.getCosmetic': {
      useQuery: () => ({ data: { obtained: true, cosmetic: { data: { team: 'Pink' } } } }),
    },
    'event.getStandings': {
      useQuery: () => ({
        data: { teams: [], topCosmetics: [{ topicId: 'top1', points: 1 }], teamHats: {} },
      }),
    },
    'event.getMyHats': { useQuery: () => ({ data: hats, dataUpdatedAt: 1_234_567 }) },
  }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 9 }) }));
vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof EventsUtils>()),
  useTeamColor: () => () => 'pink',
  useMutateEvent: () => ({ activateCosmetic: vi.fn(), equipping: false }),
}));
let myHatsProps: Record<string, unknown> | undefined;
vi.mock('~/components/Events/ScoredEvent/MyEventHats', () => ({
  MyEventHats: (props: Record<string, unknown>) => {
    myHatsProps = props;
    return null;
  },
}));
// The live points subscriptions need the app's SignalProvider; record what the page asks for.
const live = vi.hoisted(() => ({
  teams: [] as [string, boolean][],
  myHats: undefined as Record<string, unknown> | undefined,
  topHats: undefined as Record<string, unknown> | undefined,
}));
vi.mock('~/components/Events/ScoredEvent/event-points-live', () => ({
  useEventTeamsLivePoints: (event: string, enabled: boolean) =>
    void live.teams.push([event, enabled]),
  MyHatsLivePoints: (props: Record<string, unknown>) => {
    live.myHats = props;
    return null;
  },
  TopHatsLivePoints: (props: Record<string, unknown>) => {
    live.topHats = props;
    return null;
  },
}));
// Each section's own in-view flag, in the order the page asks: hero, standings, hats, top hats.
const view = vi.hoisted(() => ({ flags: [true, true, true, true], call: 0 }));
vi.mock('~/hooks/useInView', () => ({
  useInView: () => ({ ref: { current: null }, inView: view.flags[view.call++ % 4] }),
}));

vi.mock('~/components/Events/ScoredEvent/ScoredEventHero', () => ({ ScoredEventHero: () => null }));
vi.mock('~/components/Events/ScoredEvent/TeamHatShelf', () => ({ TeamHatShelf: () => null }));
vi.mock('~/components/Events/ScoredEvent/EventRules', () => ({ EventRules: () => null }));
vi.mock('~/components/Events/ScoredEvent/TeamStandings', () => ({
  TeamStandings: () => null,
  TopHats: () => null,
}));

const { ScoredEventSections } = await import('~/components/Events/ScoredEvent/ScoredEventSections');

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe('ScoredEventSections: Your hats', () => {
  it("passes the hats and the time getMyHats answered, from the query's own dataUpdatedAt", () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const data = {
      title: 'Birthday',
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
    expect(myHatsProps?.hats).toBe(hats);
    expect(myHatsProps?.fetchedAt).toBe(1_234_567);
    // While the page is open it follows the team totals and each of the viewer's hats live.
    expect(live.teams.at(-1)).toEqual(['birthday2026', true]);
    expect(live.myHats).toEqual({ event: 'birthday2026', topicIds: ['t31'], inView: true });
  });

  // Each feed follows only its own section(s): the team totals the hero or the standings, "Your
  // hats" its list, the top hats theirs.
  it.each([
    {
      inView: 'nothing',
      flags: [false, false, false, false],
      teams: false,
      hats: false,
      top: false,
    },
    {
      inView: 'the hero',
      flags: [true, false, false, false],
      teams: true,
      hats: false,
      top: false,
    },
    {
      inView: 'the standings',
      flags: [false, true, false, false],
      teams: true,
      hats: false,
      top: false,
    },
    {
      inView: 'your hats',
      flags: [false, false, true, false],
      teams: false,
      hats: true,
      top: false,
    },
    {
      inView: 'the top hats',
      flags: [false, false, false, true],
      teams: false,
      hats: false,
      top: true,
    },
  ])('with $inView in view, follows only what that shows', ({ flags, teams, hats, top }) => {
    view.flags = flags;
    view.call = 0;
    try {
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      const data = {
        title: 'Birthday',
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
      expect(live.teams.at(-1)).toEqual(['birthday2026', teams]);
      expect(live.myHats).toEqual(expect.objectContaining({ inView: hats }));
      expect(live.topHats).toEqual({ event: 'birthday2026', topicIds: ['top1'], inView: top });
    } finally {
      view.flags = [true, true, true, true];
    }
  });

  // After the end the page names a winner; it must be the settled one the payout uses.
  it('stops following the team totals once the event has ended', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const data = {
      title: 'Birthday',
      startDate: new Date(Date.now() - 120_000),
      endDate: new Date(Date.now() - 60_000),
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
    expect(live.teams.at(-1)).toEqual(['birthday2026', false]);
  });
});
