import { describe, expect, it } from 'vitest';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import {
  getCruciblePrizeAmount,
  getCrucibleRatingLabel,
  getCrucibleStatusBadge,
  getCrucibleUrl,
  parsePrizePositions,
} from '~/utils/crucible-helpers';

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

describe('getCrucibleUrl', () => {
  it('slugs the name after the id', () => {
    expect(getCrucibleUrl(21, 'Neon Arena!')).toBe('/crucibles/21/neon-arena');
  });

  it.each(['judge', 'Judge', 'JUDGE!!'])(
    'never produces the judging route for a crucible named %s',
    (name) => {
      expect(getCrucibleUrl(21, name)).toBe('/crucibles/21/judge-crucible');
    }
  );
});

describe('getCrucibleStatusBadge', () => {
  const now = new Date('2026-09-29T12:00:00Z');
  const hoursFromNow = (h: number) => new Date(now.getTime() + h * 60 * 60 * 1000);

  it.each([
    [48, 'Active'],
    [23, 'Ending soon'],
    [-1, 'Ended'],
  ])('labels an Active crucible ending in %ih as %s', (hours, label) => {
    expect(getCrucibleStatusBadge(CrucibleStatus.Active, hoursFromNow(hours), now).label).toBe(
      label
    );
  });

  it('ignores endAt once the crucible has left Active', () => {
    expect(getCrucibleStatusBadge(CrucibleStatus.Completed, hoursFromNow(-1), now).label).toBe(
      'Completed'
    );
  });
});

describe('getCruciblePrizeAmount', () => {
  const prizePositions = [
    { position: 1, percentage: 50 },
    { position: 2, percentage: 30 },
    { position: 3, percentage: 20 },
  ];
  const amounts = (entryCount: number, positions = prizePositions) =>
    [1, 2, 3].map((position) =>
      getCruciblePrizeAmount({
        position,
        prizePositions: positions,
        entryCount,
        totalPrizePool: 1000,
      })
    );

  it('pays each place its own share when every place is filled', () => {
    expect(amounts(10)).toEqual([500, 300, 200]);
  });

  it('hands an unfilled place to the winners pro rata', () => {
    expect(amounts(2)).toEqual([625, 375, 0]);
    expect(amounts(1)).toEqual([1000, 0, 0]);
  });

  it('splits evenly when every filled place is 0%, rather than paying NaN', () => {
    const backLoaded = [
      { position: 1, percentage: 0 },
      { position: 2, percentage: 0 },
      { position: 3, percentage: 100 },
    ];
    expect(amounts(2, backLoaded)).toEqual([500, 500, 0]);
  });

  it('leaves a split that never reached 100% short by the same remainder', () => {
    const short = [
      { position: 1, percentage: 60 },
      { position: 2, percentage: 20 },
    ];
    expect(amounts(2, short).slice(0, 2)).toEqual([600, 200]);
    expect(amounts(1, short)[0]).toBe(800);
  });
});
