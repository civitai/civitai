import { describe, expect, it } from 'vitest';
import { birthday2026 } from '~/server/events/birthday2026.event';

// A team award can decide the winner, and one naming a team the event does not have (a typo, the
// wrong case) would count for nobody without a sound, while a pasted duplicate would count twice.
describe('configured team awards', () => {
  it.each([birthday2026])('$name: each names one of its teams, once, inside the event', (event) => {
    const awards = event.scoring?.teamAwards ?? [];
    for (const award of awards) {
      expect(event.teams).toContain(award.team);
      expect(award.points).toBeGreaterThan(0);
      expect(award.at >= event.startDate && award.at < event.endDate, award.reason).toBe(true);
    }
    const keys = awards.map((a) => `${a.team}|${a.at.toISOString()}|${a.reason}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
