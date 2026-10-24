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
 * The hat catalog offers a mystery box only to a viewer known not to be on a team: a visitor at
 * once, a signed-in viewer once their event cosmetic says they have not joined. Until then a joined
 * viewer would be told to join a team.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { state } = vi.hoisted(() => ({
  state: {
    user: null as { id: number } | null,
    cosmetic: { data: undefined as unknown, isFetched: false },
    showBoxes: [] as (boolean | undefined)[],
  },
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'event.getCosmetic': { useQuery: () => state.cosmetic },
    'event.getStandings': { useQuery: () => ({ data: undefined }) },
    'event.getMyHats': { useQuery: () => ({ data: [], dataUpdatedAt: 1 }) },
  }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.user }));
vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof EventsUtils>()),
  useTeamColor: () => () => 'pink',
  useMutateEvent: () => ({ activateCosmetic: vi.fn(), equipping: false }),
}));
const marker = (name: string) =>
  function Marker() {
    return React.createElement('section', { 'data-section': name });
  };
vi.mock('~/components/Events/ScoredEvent/ScoredEventHero', () => ({
  ScoredEventHero: marker('hero'),
}));
vi.mock('~/components/Events/ScoredEvent/MyEventHats', () => ({ MyEventHats: marker('hats') }));
vi.mock('~/components/HomeBlocks/ShowEventHomeBlock', () => ({ ShowEventHomeBlock: () => null }));
vi.mock('~/components/Events/ScoredEvent/event-points-live', () => ({
  useEventTeamsLivePoints: () => undefined,
  MyHatsLivePoints: () => null,
  TopHatsLivePoints: () => null,
}));
vi.mock('~/hooks/useInView', () => ({
  useInView: () => ({ ref: { current: null }, inView: true }),
}));
vi.mock('~/components/Events/ScoredEvent/TeamHatShelf', () => ({ TeamHatShelf: marker('shop') }));
vi.mock('~/components/Events/ScoredEvent/HatCatalogPreview', () => ({
  HatCatalogPreview: ({ showBoxes }: { showBoxes?: boolean }) => {
    state.showBoxes.push(showBoxes);
    return React.createElement('section', { 'data-section': 'catalog' });
  },
}));
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
  state.showBoxes = [];
});

const DAY = 24 * 60 * 60 * 1000;
function render() {
  const now = Date.now();
  const data = {
    title: 'Birthday',
    teams: ['Pink'],
    startDate: new Date(now - DAY),
    endDate: new Date(now + DAY),
    finalAt: new Date(now + 2 * DAY),
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
  return state.showBoxes.at(-1);
}

describe('the hat catalog offers a box to a viewer known not to be on a team', () => {
  it('to a signed-out visitor at once', () => {
    state.user = null;
    state.cosmetic = { data: undefined, isFetched: false };
    expect(render()).toBe(true);
  });

  it('not to a signed-in viewer whose event cosmetic has not loaded', () => {
    state.user = { id: 9 };
    state.cosmetic = { data: undefined, isFetched: false };
    expect(render()).toBe(false);
  });

  it('to a signed-in viewer whose event cosmetic says they have not joined', () => {
    state.user = { id: 9 };
    state.cosmetic = { data: { obtained: false }, isFetched: true };
    expect(render()).toBe(true);
  });
});
