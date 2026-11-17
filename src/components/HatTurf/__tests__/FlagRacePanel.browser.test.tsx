import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import type * as Trpc from '~/utils/trpc';

const h = vi.hoisted(() => ({
  open: null as { id: number; endAt: Date; coverUrl: string | null } | null,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'hatTurf.getOpenFlagCrucible': {
        useQuery: () => ({ data: h.open, refetch: async () => undefined }),
      },
    }),
  };
});
import { FlagRacePanel, HOWTO_DISMISSED_KEY } from '~/components/HatTurf/FlagRace/FlagRacePanel';
import type { FlagSummary } from '~/server/events/turf/turf.service';
import { renderWithProviders } from '../../../../test/component-setup';

const H = 3_600_000;
const flag = (imageId: number, hatsByTeam: Record<string, number>, pot: number) => ({
  imageId,
  hatsByTeam,
  players: 1,
  pot,
  winners: [],
});

function summary(over: Partial<FlagSummary> = {}): FlagSummary {
  return {
    flagDayId: 4,
    closed: false,
    cutAt: null,
    closesAt: new Date(Date.now() + 5 * H),
    frozen: false,
    teamPoints: {},
    flags: [
      flag(1, { Green: 4, Blue: 1 }, 1000),
      flag(2, { Green: 2 }, 1500),
      flag(3, { Blue: 3, Pink: 3 }, 400),
      flag(4, { Blue: 6, Green: 1 }, 600),
      flag(5, {}, 0),
    ],
    ...over,
  };
}

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const chips = () =>
  [...(q('flag-race-held')?.querySelectorAll('[aria-label]') ?? [])].map((el) =>
    el.getAttribute('aria-label')
  );

beforeEach(() => {
  localStorage.removeItem(HOWTO_DISMISSED_KEY);
  h.open = { id: 389, endAt: new Date(Date.now() + 20 * H), coverUrl: null };
});
afterEach(async () => {
  await cleanup();
});

describe('FlagRacePanel', () => {
  test('counts the flags each team alone leads, most first; a tie or an empty flag counts for nobody', async () => {
    await renderWithProviders(<FlagRacePanel event="e" summary={summary()} />);
    expect(chips()).toEqual(['Green holds 2 flags', 'Blue holds 1 flag']);
  });

  test('totals the open flags’ points, and drops the total and the chips once the race closes', async () => {
    await renderWithProviders(<FlagRacePanel event="e" summary={summary()} />);
    expect(q('flag-race-pot')?.textContent).toBe('3.5k points up for grabs');
    await cleanup();

    await renderWithProviders(
      <FlagRacePanel
        event="e"
        summary={summary({ closed: true, cutAt: new Date(), frozen: true })}
      />
    );
    expect(q('flag-race-pot')).toBeNull();
    expect(q('flag-race-held')).toBeNull();
    expect(q('flag-race-header')?.textContent).toContain('Race complete');
  });

  test('a dismissed how-it-works stays dismissed on the next visit, and the pill brings it back', async () => {
    const first = await renderWithProviders(<FlagRacePanel event="e" summary={summary()} />);
    await first.getByRole('button', { name: 'Hide how it works' }).click();
    await expect.poll(() => q('flag-race-howto')).toBeNull();
    await cleanup();

    const second = await renderWithProviders(<FlagRacePanel event="e" summary={summary()} />);
    await expect.element(second.getByText('How it works')).toBeVisible();
    expect(q('flag-race-howto')).toBeNull();
    await second.getByText('How it works').click();
    await expect.poll(() => q('flag-race-howto')).not.toBeNull();
    expect(localStorage.getItem(HOWTO_DISMISSED_KEY)).toBeNull();
  });

  test('the button goes into the running flag Crucible, and is gone when none is running', async () => {
    await renderWithProviders(<FlagRacePanel event="e" summary={summary()} />);
    expect(q('flag-race-enter')?.getAttribute('href')).toBe('/crucibles/389');
    await cleanup();

    h.open = null;
    await renderWithProviders(<FlagRacePanel event="e" summary={summary()} />);
    expect(q('flag-race-enter')).toBeNull();
  });
});
