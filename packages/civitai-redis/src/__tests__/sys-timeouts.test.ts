import { beforeEach, describe, expect, it } from 'vitest';
import {
  countSysTimeoutsWithoutSuccess,
  createSysTimeoutRecord,
  resetSysTimeouts,
} from '../sys-timeouts';

// The pure records behind the sys self-heal's timeout-rate trigger: per connection, timeouts in a
// sliding window, read as 0 while that connection succeeded in the window. The end-to-end trigger
// cases live in sys-selfheal-timeouts.test.ts.

describe('sys-timeouts record', () => {
  beforeEach(() => resetSysTimeouts());

  it('counts timeouts inside the window only', () => {
    const r = createSysTimeoutRecord();
    r.recordTimeout(1_000);
    r.recordTimeout(50_000);
    r.recordTimeout(59_000);
    expect(r.count(60_000, 61_000)).toBe(2); // 1_000 is at/under the cutoff
    expect(r.count(60_000, 120_000)).toBe(0);
  });

  it('reads 0 while a success lies inside the window, and counts again once it ages out', () => {
    const r = createSysTimeoutRecord();
    for (let i = 0; i < 15; i++) r.recordTimeout(40_000 + i * 1000);
    r.recordSuccess(30_000);
    expect(r.count(60_000, 60_000)).toBe(0);
    expect(r.count(60_000, 89_000)).toBe(0); // success still in the window
    expect(r.count(60_000, 91_000)).toBe(15); // success aged out
  });

  it("one connection's successes do not hide another connection's timeouts", () => {
    const wedged = createSysTimeoutRecord();
    const healthy = createSysTimeoutRecord();
    for (let i = 0; i < 12; i++) wedged.recordTimeout(40_000 + i * 1000);
    healthy.recordSuccess(55_000);
    expect(countSysTimeoutsWithoutSuccess(60_000, 60_000)).toBe(12);
  });

  it('reset clears the timeouts and the last success of every record', () => {
    const a = createSysTimeoutRecord();
    const b = createSysTimeoutRecord();
    a.recordTimeout(10_000);
    a.recordSuccess(10_000);
    b.recordTimeout(10_000);
    resetSysTimeouts();
    expect(countSysTimeoutsWithoutSuccess(60_000, 11_000)).toBe(0);
    a.recordTimeout(20_000);
    expect(a.count(60_000, 21_000)).toBe(1); // the success was cleared too
  });

  it('stays bounded under a long wedge (ring overwrites the oldest)', () => {
    const r = createSysTimeoutRecord();
    for (let i = 0; i < 2000; i++) r.recordTimeout(i);
    expect(r.count(1_000_000, 2000)).toBe(512);
  });

  it('sums the readings, so a wedge split across two connections counts every timeout', () => {
    const a = createSysTimeoutRecord();
    const b = createSysTimeoutRecord();
    for (let i = 0; i < 6; i++) a.recordTimeout(40_000 + i * 1000);
    for (let i = 0; i < 7; i++) b.recordTimeout(40_000 + i * 1000);
    expect(countSysTimeoutsWithoutSuccess(60_000, 60_000)).toBe(13);
  });
});
