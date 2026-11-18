import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import type * as Trpc from '~/utils/trpc';
import type { FlagRaceTotals as Totals } from '~/server/events/turf/turf.service';

const h = vi.hoisted(() => ({ data: undefined as Totals | null | undefined }));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({ 'hatTurf.getFlagRaceTotals': { useQuery: () => ({ data: h.data }) } }),
  };
});

import { FlagRaceTotals } from '~/components/HatTurf/FlagRace/FlagRaceTotals';
import { renderWithProviders } from '../../../../test/component-setup';

const rows = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="flag-race-totals-team"]')].map((r) => ({
    text: r.textContent,
    mine: r.dataset.mine === 'true',
  }));

afterEach(() => cleanup());

describe('the race so far', () => {
  test("lists every team in order with its flags won and points, and marks the viewer's team", async () => {
    h.data = {
      days: 2,
      teams: [
        { team: 'Yellow', flags: 5, points: 38200 },
        { team: 'Blue', flags: 1, points: 17900 },
        { team: 'Pink', flags: 0, points: 0 },
      ],
    };
    await renderWithProviders(<FlagRaceTotals event="e" myTeam="Blue" />);
    await expect.poll(() => rows().length).toBe(3);
    expect(rows()).toEqual([
      { text: expect.stringMatching(/^1Team Yellow38,2005 flags wonpoints$/), mine: false },
      { text: expect.stringMatching(/^2Team Blue · you17,9001 flag wonpoints$/), mine: true },
      { text: expect.stringMatching(/^3Team Pink00 flags wonpoints$/), mine: false },
    ]);
    expect(document.querySelector('[data-testid="flag-race-totals"]')?.textContent).toContain(
      '2 days done'
    );
  });

  test('shows nothing before the first day freezes', async () => {
    h.data = { days: 0, teams: [{ team: 'Yellow', flags: 0, points: 0 }] };
    await renderWithProviders(<FlagRaceTotals event="e" />);
    await new Promise((r) => setTimeout(r, 200));
    expect(document.querySelector('[data-testid="flag-race-totals"]')).toBeNull();
  });
});
