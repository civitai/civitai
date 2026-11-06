import { describe, expect, it } from 'vitest';
import type { TeamAward } from '~/server/events/base.event';
import { birthday2026 } from '~/server/events/birthday2026.event';
import { teamAwardsBy } from '~/server/events/scoring/team-awards';

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

// The music-video Crucible results as ruled: each Crucible's top three entrants' teams, read from
// the team cosmetic each one holds.
describe('birthday2026 Crucible awards', () => {
  const ends = {
    254: '2026-11-06T11:15:06.595Z',
    255: '2026-11-06T11:15:07.088Z',
    256: '2026-11-06T11:15:07.565Z',
  };
  it.each([
    [254, '1st', 'Green', 500_000],
    [254, '2nd', 'Blue', 300_000],
    [254, '3rd', 'Blue', 200_000],
    [255, '1st', 'Yellow', 500_000],
    [255, '2nd', 'Blue', 300_000],
    [255, '3rd', 'Yellow', 200_000],
    [256, '1st', 'Pink', 500_000],
    [256, '2nd', 'Yellow', 300_000],
    [256, '3rd', 'Blue', 200_000],
  ] as const)('Crucible %i, %s: %s gets %i at its end', (crucible, place, team, points) => {
    const rows = birthday2026.scoring?.teamAwards?.filter(
      (a) => a.reason.startsWith(`Crucible ${crucible} `) && a.reason.endsWith(`, ${place}`)
    );
    expect(rows?.map((a) => [a.team, a.points, a.at.toISOString()])).toEqual([
      [team, points, ends[crucible]],
    ]);
  });

  it('settles 3M by the end of the event: Blue and Yellow 1M each, Green and Pink 500k', () => {
    const totals: Record<string, number> = {};
    for (const { team, points } of teamAwardsBy(birthday2026, birthday2026.endDate))
      totals[team] = (totals[team] ?? 0) + points;
    expect(totals).toEqual({ Blue: 1_000_000, Yellow: 1_000_000, Green: 500_000, Pink: 500_000 });
  });

  it('counts none of them before the referee cut passes the Crucibles’ end', () => {
    expect(teamAwardsBy(birthday2026, new Date(ends[254]))).toEqual([]);
  });
});

describe('teamAwardsBy', () => {
  it('counts an award naming a team the event does not have for nobody', () => {
    const at = new Date('2026-11-06T00:00:00.000Z');
    const awarded = {
      ...birthday2026,
      scoring: {
        teamAwards: [
          { team: 'blue', points: 7, at, reason: 'typo' },
          { team: 'Blue', points: 5, at, reason: 'real' },
        ],
      },
    };
    expect(teamAwardsBy(awarded, birthday2026.endDate).map((a) => a.reason)).toEqual(['real']);
  });
});
