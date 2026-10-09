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

const hats = [{ cosmeticId: 31, claimKey: 'claimed', points: 5, moveCooldownLeftMs: 60_000 }];
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'event.getCosmetic': {
      useQuery: () => ({ data: { obtained: true, cosmetic: { data: { team: 'Pink' } } } }),
    },
    'event.getStandings': { useQuery: () => ({ data: undefined }) },
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
  });
});
