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
 * The scored-event page orders its sections by where the viewer is: a visitor learns how it works
 * before the standings, a player sees their own hats first, and an ended event leads with the
 * result and drops the shop and the rules.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cosmetic: unknown;
const hats = [
  { cosmeticId: 31, claimKey: 'claimed', points: 5 },
  { cosmeticId: 32, claimKey: 'txn-1', points: 7 },
];
type Team = { team: string; score: number; rank: number };
const PINK_THIRD: Team[] = [{ team: 'Pink', score: 4200, rank: 3 }];
let teams: Team[] | undefined = PINK_THIRD;
let snapshotAt = new Date();
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'event.getCosmetic': { useQuery: () => ({ data: cosmetic }) },
    'event.getStandings': {
      useQuery: () => ({
        data: teams && { teams, teamHats: [], topCosmetics: [], updatedAt: snapshotAt },
      }),
    },
    'event.getMyHats': { useQuery: () => ({ data: hats, dataUpdatedAt: 1 }) },
  }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 9 }) }));
vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof EventsUtils>()),
  useTeamColor: () => () => 'pink',
  useMutateEvent: () => ({ activateCosmetic: vi.fn(), equipping: false }),
}));
const marker = (name: string) =>
  function Marker() {
    return React.createElement('section', { 'data-section': name });
  };
let heroProps: Record<string, unknown> = {};
vi.mock('~/components/Events/ScoredEvent/ScoredEventHero', () => ({
  ScoredEventHero: (props: Record<string, unknown>) => {
    heroProps = props;
    return React.createElement('section', { 'data-section': 'hero' });
  },
}));
vi.mock('~/components/Events/ScoredEvent/MyEventHats', () => ({ MyEventHats: marker('hats') }));
vi.mock('~/components/Events/ScoredEvent/TeamHatShelf', () => ({ TeamHatShelf: marker('shop') }));
vi.mock('~/components/Events/ScoredEvent/EventRules', () => ({ EventRules: marker('rules') }));
vi.mock('~/components/Events/ScoredEvent/TeamStandings', () => ({
  TeamStandings: marker('standings'),
  TopHats: marker('topHats'),
}));

const { ScoredEventSections } = await import('~/components/Events/ScoredEvent/ScoredEventSections');

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  teams = PINK_THIRD;
  snapshotAt = new Date();
});

const DAY = 24 * 60 * 60 * 1000;
function sections({
  joined,
  ended,
  finalized = true,
}: {
  joined: boolean;
  ended: boolean;
  /** Past the end plus the finalize window; only meaningful once ended. */
  finalized?: boolean;
}) {
  cosmetic = joined
    ? { obtained: true, cosmetic: { data: { team: 'Pink' } } }
    : { obtained: false };
  const now = Date.now();
  const data = {
    title: 'Birthday',
    teams: ['Pink'],
    startDate: new Date(now - 3 * DAY),
    endDate: new Date(ended ? now - DAY : now + DAY),
    finalAt: new Date(ended ? (finalized ? now - DAY / 2 : now + DAY / 2) : now + 2 * DAY),
  } as unknown as React.ComponentProps<typeof ScoredEventSections>['data'];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(ScoredEventSections, { event: 'birthday2026', data })
      )
    )
  );
  // The page's own children in order; the not-joined shop slot is the join prompt card.
  const page = host.querySelector('.mantine-Stack-root')!;
  return [...page.children].map(
    (el) =>
      el.getAttribute('data-section') ??
      (el.textContent?.includes('Join to shop for hats') ? 'joinPrompt' : el.outerHTML)
  );
}

describe('ScoredEventSections order', () => {
  it('a visitor who has not joined: how it works, the shop prompt, then the standings', () => {
    expect(sections({ joined: false, ended: false })).toEqual([
      'hero',
      'rules',
      'joinPrompt',
      'standings',
      'topHats',
    ]);
  });

  it('a player: their hats first, then standings, shop, top hats, rules', () => {
    expect(sections({ joined: true, ended: false })).toEqual([
      'hero',
      'hats',
      'standings',
      'shop',
      'topHats',
      'rules',
    ]);
  });

  it('after the end: the result first, their hats last, no shop and no rules', () => {
    expect(sections({ joined: true, ended: true })).toEqual([
      'hero',
      'standings',
      'topHats',
      'hats',
    ]);
  });

  it("hands the hero the player's team, its rank and its points", () => {
    sections({ joined: true, ended: false });
    expect(heroProps).toMatchObject({ team: 'Pink', rank: 3, teamPoints: 4200, points: 12 });
    expect(heroProps).toMatchObject({ ended: false, finalizing: false });
    expect(heroProps.winner).toBeUndefined();
  });
});

describe('ScoredEventSections: the result the hero announces', () => {
  const lead: Team[] = [
    { team: 'Yellow', score: 30, rank: 1 },
    { team: 'Pink', score: 20, rank: 2 },
  ];

  // Scores keep taking late data for a day after the end, so the leader then is not the winner.
  it('names no winner while the final scores are being tallied', () => {
    teams = lead;
    sections({ joined: true, ended: true, finalized: false });
    expect(heroProps).toMatchObject({ ended: true, finalizing: true });
    expect(heroProps.winner).toBeUndefined();
  });

  // The standings snapshot is hourly; one taken before finalAt can predate the last scoring run.
  it('keeps tallying until a standings snapshot from after the final run is on the page', () => {
    teams = lead;
    snapshotAt = new Date(Date.now() - DAY);
    sections({ joined: true, ended: true });
    expect(heroProps).toMatchObject({ ended: true, finalizing: true });
    expect(heroProps.winner).toBeUndefined();
  });

  it('names the rank-1 team once the result is final', () => {
    teams = lead;
    sections({ joined: true, ended: true });
    expect(heroProps).toMatchObject({ ended: true, finalizing: false, winner: 'Yellow' });
  });

  // Ranks are unique, so the payout crowns one team even on equal points; the page names the same
  // team rather than announcing a tie the payout contradicts.
  it('on equal points names the same rank-1 team the payout does', () => {
    teams = [
      { team: 'Pink', score: 30, rank: 2 },
      { team: 'Yellow', score: 30, rank: 1 },
    ];
    sections({ joined: true, ended: true });
    expect(heroProps.winner).toBe('Yellow');
  });

  it('claims nothing without standings', () => {
    teams = undefined;
    sections({ joined: true, ended: true });
    expect(heroProps).toMatchObject({ ended: true, finalizing: false });
    expect(heroProps.winner).toBeUndefined();
  });

  it('claims nothing while the event is live', () => {
    teams = lead;
    sections({ joined: true, ended: false });
    expect(heroProps.winner).toBeUndefined();
  });
});
