import { describe, expect, it } from 'vitest';
import { BURSTS, burstDue, burstRoller, type Served } from './cadence';

const r = (id: number): Served => ({ yesno: false, key: `r${id}` });
const y = (id: number): Served => ({ yesno: true, key: `y${id}` });
const always = (value: number) => () => value;

/** Plays `slots` feed slots through the cadence, as the feed would with endless ratings and questions. */
function play(slots: number, roll: (key: string) => number) {
  const served: Served[] = [];
  for (let i = 0; i < slots; i++) served.push(burstDue(served, roll) ? y(i) : r(i));
  return served;
}
const runs = (served: Served[]) => {
  const out: { yesno: boolean; length: number }[] = [];
  for (const s of served) {
    const last = out.at(-1);
    if (last && last.yesno === s.yesno) last.length++;
    else out.push({ yesno: s.yesno, length: 1 });
  }
  return out;
};

describe('burstDue', () => {
  it('serves ratings until the rolled gap is reached, then starts a burst', () => {
    // The lowest roll: a gap of 5 and a burst of 1.
    const low = always(0);
    expect(burstDue([], low)).toBe(false);
    expect(burstDue([r(1), r(2), r(3), r(4)], low)).toBe(false);
    expect(burstDue([r(1), r(2), r(3), r(4), r(5)], low)).toBe(true);
  });

  it('keeps the burst going for its rolled length, then goes back to ratings', () => {
    // The highest roll: a gap of 10 and a burst of 5.
    const high = always(0.999);
    const gap = Array.from({ length: 10 }, (_, i) => r(i));
    expect(burstDue(gap.slice(0, 9), high)).toBe(false);
    expect(burstDue(gap, high)).toBe(true);
    expect(burstDue([...gap, y(1), y(2), y(3), y(4)], high)).toBe(true);
    expect(burstDue([...gap, y(1), y(2), y(3), y(4), y(5)], high)).toBe(false);
  });

  it('rolls each gap and burst from the item that ended the run before it, so the same history gives the same answer', () => {
    const seen: string[] = [];
    const roll = (key: string) => {
      seen.push(key);
      return 0;
    };
    burstDue([y(7), r(1), r(2)], roll);
    burstDue([r(3), y(8), y(9)], roll);
    burstDue([r(4)], roll);
    expect(seen).toEqual(['gap:y7', 'burst:r3', 'gap:start']);
  });

  it('only offers the gaps 5, 8 and 10 and bursts of 1 to 5', () => {
    expect(BURSTS.gaps).toEqual([5, 8, 10]);
    expect(BURSTS.burst).toEqual({ min: 1, max: 5 });
  });

  it('over a long session, mixes about 28% questions in bursts of 1-5 between 5, 8 or 10 ratings', () => {
    const served = play(5000, burstRoller('secret', 42));
    const share = served.filter((s) => s.yesno).length / served.length;
    expect(share).toBeGreaterThan(0.24);
    expect(share).toBeLessThan(0.32);

    // The last run is cut off where the session ends.
    const all = runs(served).slice(0, -1);
    const bursts = all.filter((run) => run.yesno).map((run) => run.length);
    const gaps = all.filter((run) => !run.yesno).map((run) => run.length);
    expect(new Set(bursts)).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(new Set(gaps)).toEqual(new Set([5, 8, 10]));
  });

  it('rolls differently for different players', () => {
    const a = play(200, burstRoller('secret', 1)).map((s) => s.yesno);
    const b = play(200, burstRoller('secret', 2)).map((s) => s.yesno);
    expect(a).not.toEqual(b);
  });
});
