import { describe, expect, it } from 'vitest';
import {
  describeEntityTypes,
  minutesUntilMovable,
  teamPositionsOverTime,
} from '~/components/Events/ScoredEvent/scored-event.utils';

const d = (day: number) => new Date(Date.UTC(2026, 10, 10 + day));

describe('teamPositionsOverTime', () => {
  it('ranks teams by their running total each day', () => {
    const result = teamPositionsOverTime([
      {
        team: 'Yellow',
        scores: [
          { date: d(1), score: 10 },
          { date: d(2), score: 30 },
        ],
      },
      {
        team: 'Pink',
        scores: [
          { date: d(1), score: 20 },
          { date: d(2), score: 25 },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        team: 'Yellow',
        positions: [
          { date: d(1), position: 2 },
          { date: d(2), position: 1 },
        ],
      },
      {
        team: 'Pink',
        positions: [
          { date: d(1), position: 1 },
          { date: d(2), position: 2 },
        ],
      },
    ]);
  });

  // History only has a row for a day a team scored. A team with no row keeps its total: read as
  // zero, Pink would fall to last on day 2 although it is still ahead.
  it('carries a total forward over a day with no row for that team', () => {
    const [, pink] = teamPositionsOverTime([
      {
        team: 'Yellow',
        scores: [
          { date: d(1), score: 5 },
          { date: d(2), score: 10 },
        ],
      },
      { team: 'Pink', scores: [{ date: d(1), score: 50 }] },
    ]);
    expect(pink.positions.map((p) => p.position)).toEqual([1, 1]);
  });

  it('gives tied teams the same, better position', () => {
    const result = teamPositionsOverTime([
      { team: 'Yellow', scores: [{ date: d(1), score: 7 }] },
      { team: 'Blue', scores: [{ date: d(1), score: 7 }] },
      { team: 'Green', scores: [{ date: d(1), score: 3 }] },
    ]);
    expect(result.map((r) => r.positions[0].position)).toEqual([1, 1, 3]);
  });
});

describe('describeEntityTypes', () => {
  it('lists the types a decoration can be worn on in plain words', () => {
    expect(describeEntityTypes(['Image', 'Model', 'Article'])).toBe('images, models and articles');
    expect(describeEntityTypes(['Image'])).toBe('images');
  });
});

describe('minutesUntilMovable', () => {
  const now = new Date('2026-11-12T10:00:00Z');
  it('rounds a part minute up, so the button never says 0 while still locked', () => {
    expect(minutesUntilMovable(new Date('2026-11-12T10:00:30Z'), now)).toBe(1);
    expect(minutesUntilMovable(new Date('2026-11-12T10:07:00Z'), now)).toBe(7);
  });
  it('is 0 once the hat can move, or if it was never placed', () => {
    expect(minutesUntilMovable(new Date('2026-11-12T09:59:00Z'), now)).toBe(0);
    expect(minutesUntilMovable(null, now)).toBe(0);
  });
});
