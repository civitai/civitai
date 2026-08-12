import { describe, expect, it } from 'vitest';
import {
  orderPlacements,
  placementRevealDelays,
  revealDurationForSpan,
} from '~/components/Sticker/placement-order';

const at = (id: number, iso: string) => ({ id, placedAt: new Date(iso) });

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe('orderPlacements', () => {
  it('puts the oldest first, so the last one placed draws on top', () => {
    const ordered = orderPlacements([
      at(3, '2026-08-12T12:00:00Z'),
      at(1, '2026-08-10T09:00:00Z'),
      at(2, '2026-08-11T22:30:00Z'),
    ]);

    expect(ordered.map((p) => p.id)).toEqual([1, 2, 3]);
  });

  it('breaks a shared timestamp by id rather than leaving it to the input', () => {
    const same = '2026-08-12T12:00:00Z';

    expect(orderPlacements([at(9, same), at(4, same), at(7, same)]).map((p) => p.id)).toEqual([
      4, 7, 9,
    ]);
  });

  it('orders string timestamps the same way as Date ones', () => {
    const ordered = orderPlacements([
      { id: 2, placedAt: '2026-08-12T12:00:00Z' },
      { id: 1, placedAt: '2026-08-12T11:00:00Z' },
    ]);

    expect(ordered.map((p) => p.id)).toEqual([1, 2]);
  });

  it('leaves the caller its own array', () => {
    const input = [at(2, '2026-08-12T12:00:00Z'), at(1, '2026-08-10T09:00:00Z')];
    orderPlacements(input);

    expect(input.map((p) => p.id)).toEqual([2, 1]);
  });
});

describe('placementRevealDelays', () => {
  it('holds nothing back when there is nothing to sequence', () => {
    expect(placementRevealDelays([])).toEqual([]);
    expect(placementRevealDelays([at(1, '2026-08-12T12:00:00Z')])).toEqual([0]);
  });

  it('reveals in order, the first one immediately', () => {
    const delays = placementRevealDelays([
      at(1, '2026-08-12T12:00:00Z'),
      at(2, '2026-08-12T12:01:00Z'),
      at(3, '2026-08-12T12:02:00Z'),
    ]);

    expect(delays[0]).toBe(0);
    expect(delays[1]).toBeGreaterThan(0);
    expect(delays[2]).toBeGreaterThan(delays[1]);
  });

  it('gives a longer share of the reveal to a longer real gap', () => {
    const base = new Date('2026-08-12T00:00:00Z').getTime();
    // Measured as a SHARE, not as a duration. The sequence is normalised to the
    // chosen length, so with only two stickers the single pause is always the
    // whole of it however far apart they were placed — the dilation lives in how
    // the length is divided up, and needs three placements to be visible at all.
    const share = (secondGapMs: number) => {
      const delays = placementRevealDelays(
        [
          { id: 1, placedAt: new Date(base) },
          { id: 2, placedAt: new Date(base + MINUTE) },
          { id: 3, placedAt: new Date(base + MINUTE + secondGapMs) },
        ],
        { totalMs: 3_000 }
      );
      return (delays[2] - delays[1]) / delays[2];
    };

    expect(share(HOUR)).toBeGreaterThan(share(MINUTE));
    expect(share(7 * 24 * HOUR)).toBeGreaterThan(share(HOUR));
  });

  it('takes its length from how old the history is', () => {
    const base = new Date('2026-08-12T00:00:00Z').getTime();
    const spanned = (spanMs: number) =>
      placementRevealDelays([
        { id: 1, placedAt: new Date(base) },
        { id: 2, placedAt: new Date(base + spanMs / 2) },
        { id: 3, placedAt: new Date(base + spanMs) },
      ]).at(-1) as number;

    // The complaint this replaced: a fixed length made two stickers a minute
    // apart take as long as a year-long build. An hour and a day both sit on the
    // floor — inside a day the gaps carry the pacing — and it grows from there.
    expect(spanned(HOUR)).toBe(spanned(24 * HOUR));
    expect(spanned(30 * 24 * HOUR)).toBeGreaterThan(spanned(24 * HOUR));
    expect(spanned(365 * 24 * HOUR)).toBeGreaterThan(spanned(30 * 24 * HOUR));
  });

  it('caps at a year, so a five-year history is not five times the wait', () => {
    const year = 365 * 24 * HOUR;

    expect(revealDurationForSpan(5 * year)).toBe(revealDurationForSpan(year));
    // And the floor holds at the other end, including for placements that share
    // a timestamp — a burst still has to read as a sequence.
    expect(revealDurationForSpan(0)).toBe(revealDurationForSpan(HOUR));
  });

  it('scales what the span decided by the viewer multiplier', () => {
    const span = 30 * 24 * HOUR;

    expect(revealDurationForSpan(span, 2)).toBe(revealDurationForSpan(span) * 2);
    expect(revealDurationForSpan(span, 0.5)).toBe(revealDurationForSpan(span) / 2);
  });

  it('fills the duration it is given, whatever the history looks like', () => {
    const base = new Date('2026-08-01T00:00:00Z').getTime();
    const forty = Array.from({ length: 40 }, (_, index) => ({
      id: index + 1,
      placedAt: new Date(base + index * 24 * HOUR),
    }));
    // Two stickers a minute apart are worth a fraction of a second of raw
    // sequence; forty a day apart are worth far more than the budget. Both land
    // on the same last delay, because the number is a duration the viewer chose
    // rather than a ceiling — scaling only downwards left "12 seconds" looking
    // identical to "1.5 seconds" on any image that was not heavily stickered.
    const long = placementRevealDelays(forty, { totalMs: 3_000 });
    const short = placementRevealDelays(
      [at(1, '2026-08-12T12:00:00Z'), at(2, '2026-08-12T12:01:00Z')],
      { totalMs: 3_000 }
    );

    expect(long).toHaveLength(40);
    expect(long[long.length - 1]).toBe(3_000);
    expect(short[short.length - 1]).toBe(3_000);
    // Scaled, not truncated: the last stickers are the ones deliberately placed
    // over others, and a truncated tail reveals them with no sequence at all.
    for (let i = 1; i < long.length; i++) expect(long[i]).toBeGreaterThan(long[i - 1]);
  });

  it('keeps the shape of the gaps when it stretches them', () => {
    const base = new Date('2026-08-12T00:00:00Z').getTime();
    // A short gap then a long one. Whatever the total, the second pause has to
    // stay several times the first — that ratio is the whole of the time
    // dilation, and stretching to a duration must not flatten it.
    const uneven = [
      { id: 1, placedAt: new Date(base) },
      { id: 2, placedAt: new Date(base + MINUTE) },
      { id: 3, placedAt: new Date(base + MINUTE + 7 * 24 * HOUR) },
    ];

    const ratio = (totalMs: number) => {
      const d = placementRevealDelays(uneven, { totalMs });
      return (d[2] - d[1]) / (d[1] - d[0]);
    };

    expect(ratio(1_500)).toBeGreaterThan(1.5);
    expect(ratio(12_000)).toBeCloseTo(ratio(1_500), 1);
  });

  it('never returns NaN when the whole history lands in one instant', () => {
    const same = new Date('2026-08-12T12:00:00Z');
    const delays = placementRevealDelays(
      [
        { id: 1, placedAt: same },
        { id: 2, placedAt: same },
      ],
      { totalMs: 0 }
    );

    expect(delays.every(Number.isFinite)).toBe(true);
  });
});
