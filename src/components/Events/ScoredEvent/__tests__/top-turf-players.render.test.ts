// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as EventsUtils from '~/components/Events/events.utils';

const act = (React as unknown as { act: (cb: () => void) => void }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof EventsUtils>()),
  useTeamColor: () => (team: string) => `color-${team}`,
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ userId }: { userId: number }) =>
    React.createElement('span', { 'data-user': userId }, `user${userId}`),
}));

const { TopTurfPlayers } = await import('~/components/Events/ScoredEvent/TeamStandings');

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function render(topTurfPlayers?: { userId: number; team: string; points: number }[]) {
  const standings = {
    topTurfPlayers,
    // A hat row: the board must never take its people from here.
    topCosmetics: [{ userId: 999, cosmeticId: 5, claimKey: 'claimed', team: 'Blue', points: 9000 }],
    users: {},
  } as unknown as React.ComponentProps<typeof TopTurfPlayers>['standings'];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      React.createElement(MantineProvider, null, React.createElement(TopTurfPlayers, { standings }))
    )
  );
  return host;
}
const rows = (el: Element) => [...el.querySelectorAll('[data-testid="top-turf-player"]')];

describe('Top turf players', () => {
  it('ranks the turf players with their whole points, never a hat owner', () => {
    const el = render([
      { userId: 2, team: 'Blue', points: 1234 },
      { userId: 1, team: 'Pink', points: 42 },
    ]);
    expect(rows(el).map((r) => r.textContent)).toEqual(['1user21,234', '2user142']);
    expect(el.querySelector('[data-user="999"]')).toBeNull();
  });

  it('shows ten at every width, like the hardest-working hats', () => {
    const el = render(
      Array.from({ length: 12 }, (_, i) => ({ userId: i + 1, team: 'Blue', points: 100 - i }))
    );
    const shown = rows(el);
    expect(shown).toHaveLength(10);
    expect(shown.map((r) => r.className.includes('hidden'))).toEqual(Array(10).fill(false));
  });

  it('says when turf has not scored, including on a snapshot from before the board existed', () => {
    for (const players of [[], undefined]) {
      const el = render(players);
      expect(rows(el)).toHaveLength(0);
      expect(el.textContent).toContain('Turf scores land here once the first hats start earning.');
      act(() => root?.unmount());
      host?.remove();
    }
  });
});
