import { describe, expect, it } from 'vitest';
import { resolveWinnerPicks } from '~/server/games/daily-challenge/challenge-winner-reconcile';

// Challenge 390 ("Fluffy Fun with Marshmallows!") completed with ChallengeWinner rows at places 2
// and 3 and nothing at place 1: 5,000 Buzz and 150 points never awarded, on 2,680 entries. Both
// completion paths used to number a pick by its index in the LLM's array and only THEN drop the
// picks that matched no entry, so one unresolvable pick deleted a placement instead of shifting the
// rest up — and it did so silently, since the drop was a bare `.filter(isDefined)`.
//
// `generateWinners` returns raw JSON cast to a TS type; nothing validates it at runtime. So the
// field can arrive as a numeric string (the likely real cause — strict `===` against a number fails)
// or as anything else the model emits.

const entries = [
  { userId: 11967363, imageId: 139540112, username: 'jonibon' },
  { userId: 9182050, imageId: 139515168, username: 'blueeeey' },
  { userId: 8263005, imageId: 139455779, username: 'TheRobotMonster' },
];

const pick = (creatorId: unknown, reason = 'because') => ({ creatorId, reason });

describe('resolveWinnerPicks', () => {
  it('numbers matched picks 1..n in the order the judge returned them', () => {
    const { winners, unmatched } = resolveWinnerPicks(
      [pick(8263005), pick(11967363), pick(9182050)],
      entries
    );

    expect(unmatched).toEqual([]);
    expect(winners).toEqual([
      { userId: 8263005, imageId: 139455779, position: 1, reason: 'because' },
      { userId: 11967363, imageId: 139540112, position: 2, reason: 'because' },
      { userId: 9182050, imageId: 139515168, position: 3, reason: 'because' },
    ]);
  });

  it('closes the gap when the FIRST pick resolves to nothing (the challenge 390 shape)', () => {
    const { winners, unmatched } = resolveWinnerPicks(
      [pick(999999999), pick(9182050), pick(8263005)],
      entries
    );

    // The regression: these used to come back as positions 2 and 3 with no place 1.
    expect(winners.map((w) => w.position)).toEqual([1, 2]);
    expect(winners.map((w) => w.userId)).toEqual([9182050, 8263005]);
    expect(unmatched).toEqual([{ index: 0, creatorId: 999999999 }]);
  });

  it('closes the gap when a MIDDLE pick resolves to nothing', () => {
    const { winners } = resolveWinnerPicks(
      [pick(9182050), pick(999999999), pick(8263005)],
      entries
    );

    expect(winners.map((w) => w.position)).toEqual([1, 2]);
    expect(winners.map((w) => w.userId)).toEqual([9182050, 8263005]);
  });

  it('accepts a creatorId the model returned as a numeric string', () => {
    const { winners, unmatched } = resolveWinnerPicks([pick('9182050')], entries);

    expect(unmatched).toEqual([]);
    expect(winners).toEqual([
      { userId: 9182050, imageId: 139515168, position: 1, reason: 'because' },
    ]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['a float', 9182050.5],
    ['a non-numeric string', 'blueeeey'],
    ['a padded string', ' 9182050 '],
    ['an object', { id: 9182050 }],
    ['a boolean', true],
  ])('reports %s as unmatched rather than resolving it', (_label, creatorId) => {
    const { winners, unmatched } = resolveWinnerPicks([pick(creatorId)], entries);

    expect(winners).toEqual([]);
    expect(unmatched).toEqual([{ index: 0, creatorId }]);
  });

  it('never matches on the display name, which an entrant controls', () => {
    // Keying on `creator` is what let one entrant spoof another's name and take their payout.
    const { winners, unmatched } = resolveWinnerPicks(
      [{ creatorId: 'jonibon', creator: 'jonibon', reason: 'because' }],
      entries
    );

    expect(winners).toEqual([]);
    expect(unmatched).toHaveLength(1);
  });

  it('keeps a repeated creator so the payout dedupe stays the one place that drops it', () => {
    const { winners } = resolveWinnerPicks([pick(9182050), pick(9182050)], entries);

    expect(winners.map((w) => w.userId)).toEqual([9182050, 9182050]);
    expect(winners.map((w) => w.position)).toEqual([1, 2]);
  });

  it('reports the raw creatorId and its original index for every unmatched pick', () => {
    const { unmatched } = resolveWinnerPicks(
      [pick(9182050), pick('nope'), pick(8263005), pick(null)],
      entries
    );

    expect(unmatched).toEqual([
      { index: 1, creatorId: 'nope' },
      { index: 3, creatorId: null },
    ]);
  });

  it('defaults a missing reason to null rather than undefined', () => {
    const { winners } = resolveWinnerPicks([{ creatorId: 9182050 }], entries);

    expect(winners[0].reason).toBeNull();
  });

  it('returns nothing when the judge returned no picks', () => {
    expect(resolveWinnerPicks([], entries)).toEqual({ winners: [], unmatched: [] });
  });
});
