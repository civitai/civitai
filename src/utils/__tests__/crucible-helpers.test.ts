import { describe, expect, it } from 'vitest';
import { getCrucibleRatingLabel, parsePrizePositions } from '~/utils/crucible-helpers';

describe('parsePrizePositions', () => {
  it('parses the object map the database actually stores', () => {
    expect(parsePrizePositions({ '1': 40, '2': 30, '3': 20, '4': 10 })).toEqual([
      { position: 1, percentage: 40 },
      { position: 2, percentage: 30 },
      { position: 3, percentage: 20 },
      { position: 4, percentage: 10 },
    ]);
  });

  it('still parses an array, so an older stored value is not dropped', () => {
    expect(
      parsePrizePositions([
        { position: 1, percentage: 60 },
        { position: 2, percentage: 40 },
      ])
    ).toEqual([
      { position: 1, percentage: 60 },
      { position: 2, percentage: 40 },
    ]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '{"1":50}'],
    ['a number', 50],
  ])('returns [] for %s rather than throwing', (_label, input) => {
    expect(parsePrizePositions(input)).toEqual([]);
  });

  it('drops positions that cannot pay out', () => {
    expect(
      parsePrizePositions({ '1': 100, '2': 0, '0': 25, '-1': 10, x: 5, '3': Number.NaN })
    ).toEqual([{ position: 1, percentage: 100 }]);
  });

  it('drops malformed array members without dropping the good ones', () => {
    expect(
      parsePrizePositions([
        { position: 1, percentage: 50 },
        { position: '2', percentage: 50 },
        null,
        { position: 3 },
      ])
    ).toEqual([{ position: 1, percentage: 50 }]);
  });
});

describe('getCrucibleRatingLabel', () => {
  it('reads nsfwLevel as a bitmask of accepted ratings', () => {
    // PG | PG-13 = 3. Treated as one ordered level, 3 fell under "<= 4" and read as "R".
    expect(getCrucibleRatingLabel(1 | 2)).toBe('PG / PG-13');
  });

  it('labels a single rating on its own', () => {
    expect(getCrucibleRatingLabel(1)).toBe('PG');
    expect(getCrucibleRatingLabel(4)).toBe('R');
  });
});
