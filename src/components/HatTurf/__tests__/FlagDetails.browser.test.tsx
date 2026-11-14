import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import { FlagBadge } from '~/components/HatTurf/FlagRace/FlagBadge';
import { FlagRaceContext } from '~/components/HatTurf/FlagRace/FlagRaceContext';
import { TurfSummaryContext } from '~/components/HatTurf/TurfSummaryProvider';
import type { FlagSummary } from '~/server/events/turf/turf.service';
import { renderWithProviders } from '../../../../test/component-setup';

const H = 3_600_000;
function summary(closed: boolean, hatsByTeam: Record<string, number>, winners: string[] = []) {
  return {
    flagDayId: 3,
    closed,
    frozen: closed,
    cutAt: closed ? new Date(Date.now() - 60_000) : null,
    closesAt: new Date(Date.now() + (closed ? 0 : 3 * H)),
    teamPoints: {},
    flags: [{ imageId: 7, hatsByTeam, players: 21, pot: 2500, winners }],
  } satisfies FlagSummary;
}

async function open(s: FlagSummary, team = 'Blue') {
  await renderWithProviders(
    <FlagRaceContext.Provider value={{ event: 'e', summary: s }}>
      <TurfSummaryContext.Provider
        value={{
          event: 'e',
          arm: 'control',
          team,
          images: {},
          open: {},
          stickers: {},
          joined: true,
          watch: () => () => undefined,
        }}
      >
        <FlagBadge imageId={7} />
      </TurfSummaryContext.Provider>
    </FlagRaceContext.Provider>
  );
  const badge = await vi.waitFor(() => {
    const el = document.querySelector('[data-testid="flag-badge"]') as HTMLElement | null;
    if (!el) throw new Error('badge not rendered');
    return el;
  });
  badge.click();
}

const text = (id: string) =>
  document.body.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

afterEach(() => cleanup());

describe('the flag details popover', () => {
  test('tells a trailing team how many hats take the lead, one more than the gap', async () => {
    await open(summary(false, { Green: 14, Blue: 9, Pink: 3 }));
    await expect.poll(() => text('flag-details-gap')).toBe('Blue needs 6 hats to take it');
    expect(text('flag-details-pot')).toBe('2.5k pts');
  });

  test('a tied team needs one hat; a leading team leads by its margin', async () => {
    await open(summary(false, { Green: 9, Blue: 9 }));
    await expect.poll(() => text('flag-details-gap')).toBe('Blue needs 1 hat to take it');
    await cleanup();
    await open(summary(false, { Green: 4, Blue: 9 }));
    await expect.poll(() => text('flag-details-gap')).toBe('Blue leads by 5');
  });

  test('tapping the clock chip opens the details and never the card link under it', async () => {
    const onCard = vi.fn();
    document.addEventListener('click', onCard);
    await renderWithProviders(
      <FlagRaceContext.Provider value={{ event: 'e', summary: summary(false, { Green: 2 }) }}>
        <FlagBadge imageId={7} />
      </FlagRaceContext.Provider>
    );
    const chip = await vi.waitFor(() => {
      const el = document.querySelector('[data-testid="flag-badge-clock"]') as HTMLElement | null;
      if (!el) throw new Error('chip not rendered');
      return el;
    });
    chip.click();
    await expect.poll(() => !!document.querySelector('[data-testid="flag-details"]')).toBe(true);
    document.removeEventListener('click', onCard);
    expect(onCard).not.toHaveBeenCalled();
  });

  test('a closed flag names its winner and drops the gap', async () => {
    await open(summary(true, { Green: 14, Blue: 9 }, ['Green']));
    await expect.poll(() => text('flag-details-winner')).toBe('Green won 2.5k pts');
    expect(text('flag-details-gap')).toBeNull();
  });
});
