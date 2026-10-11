import { describe, expect, it } from 'vitest';
import {
  coverRequestWidth,
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
  const MINUTE = 60_000;
  it('rounds a part minute up, so the button never says 0 while still locked', () => {
    expect(minutesUntilMovable(30_000, 0)).toBe(1);
    expect(minutesUntilMovable(10 * MINUTE, 3 * MINUTE)).toBe(7);
  });
  it('is 0 once the hat can move, or if it was never placed', () => {
    expect(minutesUntilMovable(5 * MINUTE, 6 * MINUTE)).toBe(0);
    expect(minutesUntilMovable(0, 0)).toBe(0);
  });
  // A browser clock that jumps backwards after the fetch must not add to the server's count.
  it('never shows more than the server reported', () => {
    expect(minutesUntilMovable(10 * MINUTE, -5 * MINUTE)).toBe(10);
  });
});

describe('coverRequestWidth', () => {
  const meta = (width: unknown, height: unknown) => ({ metadata: { width, height } });

  it('asks for the card width when the picture is no wider than the 4:5 card', () => {
    expect(coverRequestWidth(meta(800, 1000), 450)).toBe(450);
    expect(coverRequestWidth(meta(600, 1200), 450)).toBe(450);
  });

  // A 2:1 cover at 450 wide comes back 225 tall and is stretched to fill a 562px-tall card.
  it('asks for enough width that a wide cover still fills the height', () => {
    expect(coverRequestWidth(meta(1000, 1000), 450)).toBe(563);
    expect(coverRequestWidth(meta(1600, 1000), 450)).toBe(900);
    expect(coverRequestWidth(meta(2000, 1000), 320)).toBe(800);
  });

  it('stops at the cap however wide the picture', () => {
    expect(coverRequestWidth(meta(2000, 1000), 450)).toBe(1125);
    expect(coverRequestWidth(meta(4000, 1000), 450)).toBe(1200);
  });

  // About 6% of covers have no size in their metadata but do on the image row.
  it("takes the image row's own size first, then the metadata's", () => {
    expect(coverRequestWidth({ width: 2000, height: 1000, metadata: null }, 450)).toBe(1125);
    expect(
      coverRequestWidth({ width: 2000, height: 1000, metadata: { width: 800, height: 1000 } }, 450)
    ).toBe(1125);
    expect(coverRequestWidth({ width: null, height: null, ...meta(2000, 1000) }, 450)).toBe(1125);
  });

  it('does not stretch a video, which is transcoded at the width asked for', () => {
    expect(coverRequestWidth({ type: 'video', ...meta(1920, 1080) }, 450)).toBe(450);
    expect(coverRequestWidth({ type: 'image', ...meta(1920, 1080) }, 450)).toBe(1000);
  });

  it('falls back to the old fixed width without a usable size', () => {
    expect(coverRequestWidth({ metadata: null }, 450)).toBe(320);
    expect(coverRequestWidth({}, 450)).toBe(320);
    expect(coverRequestWidth(meta(2000, 0), 450)).toBe(320);
    expect(coverRequestWidth(meta(0, 1000), 450)).toBe(320);
    expect(coverRequestWidth(meta('2000', 1000), 450)).toBe(320);
  });
});
