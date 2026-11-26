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
    const low = always(0);
    const ratings = (n: number) => Array.from({ length: n }, (_, i) => r(i));
    expect(burstDue([], low)).toBe(false);
    expect(burstDue(ratings(14), low)).toBe(false);
    expect(burstDue(ratings(15), low)).toBe(true);
  });

  it('keeps the burst going for its rolled length, then goes back to ratings', () => {
    const high = always(0.999);
    const gap = Array.from({ length: 20 }, (_, i) => r(i));
    const burst = (n: number) => Array.from({ length: n }, (_, i) => y(i));
    expect(burstDue(gap.slice(0, 19), high)).toBe(false);
    expect(burstDue(gap, high)).toBe(true);
    expect(burstDue([...gap, ...burst(9)], high)).toBe(true);
    expect(burstDue([...gap, ...burst(10)], high)).toBe(false);
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

  it('only offers the gaps 15, 18 and 20 and bursts of 5 to 10', () => {
    expect(BURSTS.gaps).toEqual([15, 18, 20]);
    expect(BURSTS.burst).toEqual({ min: 5, max: 10 });
  });

  it('over a long session, mixes about 30% questions in bursts of 5-10 between 15, 18 or 20 ratings', () => {
    const served = play(5000, burstRoller('secret', 42));
    const share = served.filter((s) => s.yesno).length / served.length;
    expect(share).toBeGreaterThan(0.26);
    expect(share).toBeLessThan(0.34);

    // The last run is cut off where the session ends.
    const all = runs(served).slice(0, -1);
    const bursts = all.filter((run) => run.yesno).map((run) => run.length);
    const gaps = all.filter((run) => !run.yesno).map((run) => run.length);
    expect(new Set(bursts)).toEqual(new Set([5, 6, 7, 8, 9, 10]));
    expect(new Set(gaps)).toEqual(new Set([15, 18, 20]));
  });

  it('rolls differently for different players', () => {
    const a = play(200, burstRoller('secret', 1)).map((s) => s.yesno);
    const b = play(200, burstRoller('secret', 2)).map((s) => s.yesno);
    expect(a).not.toEqual(b);
  });
});
