import { describe, expect, it } from 'vitest';
import { orderPlacements, placementRevealDelays } from '~/components/Sticker/placement-order';

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

  it('pauses longer where the real gap was longer', () => {
    const base = new Date('2026-08-12T12:00:00Z').getTime();
    const gaps = (ms: number) =>
      placementRevealDelays([
        { id: 1, placedAt: new Date(base) },
        { id: 2, placedAt: new Date(base + ms) },
      ])[1];

    // A minute apart, an hour apart, a week apart: each step strictly longer
    // than the last. This is the property the "time dilation" is FOR — a
    // constant step would satisfy every other assertion here.
    expect(gaps(HOUR)).toBeGreaterThan(gaps(MINUTE));
    expect(gaps(7 * 24 * HOUR)).toBeGreaterThan(gaps(HOUR));
  });

  it('fits a long history inside the budget instead of dropping its tail', () => {
    const base = new Date('2026-08-01T00:00:00Z').getTime();
    // Forty stickers, each a day apart — every gap at the per-step ceiling, so
    // the uncapped sequence runs far past anything watchable.
    const placements = Array.from({ length: 40 }, (_, index) => ({
      id: index + 1,
      placedAt: new Date(base + index * 24 * HOUR),
    }));

    const delays = placementRevealDelays(placements, { maxTotalMs: 3_000 });

    expect(delays).toHaveLength(40);
    expect(delays[delays.length - 1]).toBeLessThanOrEqual(3_000);
    // Scaled, not truncated: the last stickers are the ones deliberately placed
    // over others, and a truncated tail reveals them with no sequence at all.
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThan(delays[i - 1]);
  });

  it('never returns NaN when the whole history lands in one instant', () => {
    const same = new Date('2026-08-12T12:00:00Z');
    const delays = placementRevealDelays(
      [
        { id: 1, placedAt: same },
        { id: 2, placedAt: same },
      ],
      { maxTotalMs: 0 }
    );

    expect(delays.every(Number.isFinite)).toBe(true);
  });
});
