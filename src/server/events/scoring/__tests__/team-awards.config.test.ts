import { describe, expect, it } from 'vitest';
import type { TeamAward } from '~/server/events/base.event';
import { birthday2026 } from '~/server/events/birthday2026.event';

// A team award can decide the winner, and one naming a team the event does not have (a typo, the
// wrong case) would count for nobody without a sound, while a pasted duplicate would count twice.
type AwardedEvent = {
  name: string;
  teams: readonly string[];
  startDate: Date;
  endDate: Date;
  scoring?: { teamAwards?: readonly TeamAward[] };
};
function awardProblems({ teams, startDate, endDate, scoring }: AwardedEvent) {
  const awards = scoring?.teamAwards ?? [];
  const problems = awards.flatMap((a) => [
    ...(teams.includes(a.team) ? [] : [`unknown team ${a.team}`]),
    ...(a.points > 0 ? [] : [`no points: ${a.reason}`]),
    ...(a.at >= startDate && a.at < endDate ? [] : [`outside the event: ${a.reason}`]),
  ]);
  const keys = awards.map((a) => `${a.team}|${a.at.toISOString()}|${a.reason}`);
  if (new Set(keys).size !== keys.length) problems.push('duplicate award');
  return problems;
}

describe('configured team awards', () => {
  it.each([birthday2026])('$name: each names one of its teams, once, inside the event', (event) => {
    expect(awardProblems(event)).toEqual([]);
  });

  it('positive control: the check finds each kind of mistake', () => {
    const at = new Date('2026-11-06T00:00:00.000Z');
    const row = (team: string, points = 500_000, when = at) => ({
      team,
      points,
      at: when,
      reason: 'Crucible 1, 1st',
    });
    expect(
      awardProblems({
        ...birthday2026,
        scoring: {
          teamAwards: [
            row('blue'),
            row('Pink', 0),
            row('Green', 1, new Date('2026-12-01T00:00:00.000Z')),
            row('Yellow'),
            row('Yellow'),
          ],
        },
      })
    ).toEqual([
      'unknown team blue',
      'no points: Crucible 1, 1st',
      'outside the event: Crucible 1, 1st',
      'duplicate award',
    ]);
  });
});
