import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup } from 'vitest-browser-react';
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
    nextCrucible: { id: 389, endAt: new Date(Date.now() + 20 * H), coverUrl: null },
    ...over,
  };
}

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const chips = () =>
  [...(q('flag-race-held')?.querySelectorAll('[aria-label]') ?? [])].map((el) =>
    el.getAttribute('aria-label')
  );

beforeEach(() => localStorage.removeItem(HOWTO_DISMISSED_KEY));
afterEach(async () => {
  await cleanup();
});

describe('FlagRacePanel', () => {
  test('counts the flags each team alone leads, most first; a tie or an empty flag counts for nobody', async () => {
    await renderWithProviders(<FlagRacePanel summary={summary()} />);
    expect(chips()).toEqual(['Green holds 2 flags', 'Blue holds 1 flag']);
  });

  test('totals the open flags’ points, and drops the total and the chips once the race closes', async () => {
    await renderWithProviders(<FlagRacePanel summary={summary()} />);
    expect(q('flag-race-pot')?.textContent).toBe('3.5k points up for grabs');
    await cleanup();

    await renderWithProviders(
      <FlagRacePanel summary={summary({ closed: true, cutAt: new Date(), frozen: true })} />
    );
    expect(q('flag-race-pot')).toBeNull();
    expect(q('flag-race-held')).toBeNull();
    expect(q('flag-race-header')?.textContent).toContain('Race complete');
  });

  test('a dismissed how-it-works stays dismissed on the next visit, and the pill brings it back', async () => {
    const first = await renderWithProviders(<FlagRacePanel summary={summary()} />);
    await first.getByRole('button', { name: 'Hide how it works' }).click();
    expect(q('flag-race-howto')).toBeNull();
    await cleanup();

    const second = await renderWithProviders(<FlagRacePanel summary={summary()} />);
    await expect.poll(() => q('flag-race-howto')).toBeNull();
    await second.getByText('How it works').click();
    expect(q('flag-race-howto')).not.toBeNull();
    expect(localStorage.getItem(HOWTO_DISMISSED_KEY)).toBeNull();
  });

  test('the button goes into the running flag Crucible, and is gone when none is running', async () => {
    await renderWithProviders(<FlagRacePanel summary={summary()} />);
    expect(q('flag-race-enter')?.getAttribute('href')).toBe('/crucibles/389');
    await cleanup();

    await renderWithProviders(<FlagRacePanel summary={summary({ nextCrucible: null })} />);
    expect(q('flag-race-enter')).toBeNull();
  });
});
