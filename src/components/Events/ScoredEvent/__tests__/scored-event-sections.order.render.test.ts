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
const hats = [{ cosmeticId: 31, claimKey: 'claimed', points: 5 }];
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'event.getCosmetic': { useQuery: () => ({ data: cosmetic }) },
    'event.getStandings': {
      useQuery: () => ({ data: { teams: [], teamHats: [], topCosmetics: [] } }),
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
const marker = (name: string) => () => React.createElement('section', { 'data-section': name });
vi.mock('~/components/Events/ScoredEvent/ScoredEventHero', () => ({
  ScoredEventHero: marker('hero'),
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
});

const DAY = 24 * 60 * 60 * 1000;
function sections({ joined, ended }: { joined: boolean; ended: boolean }) {
  cosmetic = joined
    ? { obtained: true, cosmetic: { data: { team: 'Pink' } } }
    : { obtained: false };
  const now = Date.now();
  const data = {
    title: 'Birthday',
    teams: ['Pink'],
    startDate: new Date(now - 3 * DAY),
    endDate: new Date(ended ? now - DAY : now + DAY),
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
});
