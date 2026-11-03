import { describe, expect, it } from 'vitest';
import { PROGRESSION } from './progression/config';
import { fervorCopy, nextTally } from './leaderboard-view';
import { standingGap, viewBoard } from './leaderboard';

const rows = (...fervors: number[]) =>
  fervors.map((fervor, i) => ({
    userId: i + 1,
    username: `u${i + 1}`,
    image: null,
    rankType: 'Knight',
    level: 1,
    fervor,
  }));

describe('standingGap', () => {
  it('has none for first place', () => {
    expect(standingGap(rows(900, 500), 0)).toBeNull();
  });

  it('is the distance to the place above', () => {
    expect(standingGap(rows(900, 700, 388, 100), 2)).toEqual({ place: 2, gap: 312 });
  });

  it('is 0 when tied with the place above', () => {
    expect(standingGap(rows(900, 500, 500), 2)).toEqual({ place: 2, gap: 0 });
  });

  it('is carried on the viewer outside the top list, with their true place', () => {
    const view = viewBoard({ rows: rows(900, 800, 700, 600, 450), badges: {} }, 5, { size: 3 });

    expect(view.entries).toHaveLength(3);
    expect(view.self).toMatchObject({ position: 5, behind: { place: 4, gap: 150 } });
  });

  it('is carried on a viewer inside the list too, and absent for the leader', () => {
    const board = { rows: rows(900, 800, 700), badges: {} };

    expect(viewBoard(board, 2).self).toMatchObject({ position: 2, behind: { place: 1, gap: 100 } });
    expect(viewBoard(board, 1).self?.behind).toBeNull();
  });
});

describe('nextTally', () => {
  it.each([
    ['2026-12-15T17:48:00Z', '6h 12m'],
    ['2026-12-15T00:00:00Z', '24h 0m'],
    ['2026-12-15T23:59:30Z', '0h 0m'],
    ['2026-12-15T23:00:00Z', '1h 0m'],
    ['2026-12-31T12:30:00Z', '11h 30m'],
  ])('from %s it is %s to the next UTC midnight', (at, text) => {
    expect(nextTally(new Date(at))).toBe(text);
  });
});

describe('fervorCopy', () => {
  it('builds the formula and the example from the config', () => {
    const copy = fervorCopy();

    expect(copy.formula).toBe(
      `Correct judgments × ${PROGRESSION.fervorPerCorrect} × your accuracy`
    );
    expect(copy.window).toContain(`last ${PROGRESSION.fervorWindowDays} days`);
    expect(copy.accuracy).toContain(`${PROGRESSION.fervorAccuracyFloor * 100}%`);
    expect(copy.example).toBe(
      'Example: 400 right of 500 judged is 400 × 100 × 80% = 32,000 fervor.'
    );
  });
});
