import { beforeEach, describe, expect, it } from 'vitest';
import {
  countSysTimeoutsWithoutSuccess,
  recordSysCommandSuccess,
  recordSysCommandTimeout,
  resetSysTimeouts,
} from '../sys-timeouts';

// The pure record behind the sys self-heal's timeout-rate trigger: timeouts in a sliding window,
// read as 0 while any sys command succeeded in that window. The end-to-end trigger cases live in
// sys-selfheal-timeouts.test.ts.

describe('sys-timeouts record', () => {
  beforeEach(() => resetSysTimeouts());

  it('counts timeouts inside the window only', () => {
    recordSysCommandTimeout(1_000);
    recordSysCommandTimeout(50_000);
    recordSysCommandTimeout(59_000);
    expect(countSysTimeoutsWithoutSuccess(60_000, 61_000)).toBe(2); // 1_000 is at/under the cutoff
    expect(countSysTimeoutsWithoutSuccess(60_000, 120_000)).toBe(0);
  });

  it('reads 0 while a success lies inside the window, and counts again once it ages out', () => {
    for (let i = 0; i < 15; i++) recordSysCommandTimeout(40_000 + i * 1000);
    recordSysCommandSuccess(30_000);
    expect(countSysTimeoutsWithoutSuccess(60_000, 60_000)).toBe(0);
    expect(countSysTimeoutsWithoutSuccess(60_000, 89_000)).toBe(0); // success still in the window
    expect(countSysTimeoutsWithoutSuccess(60_000, 91_000)).toBe(15); // success aged out
  });

  it('reset clears both the timeouts and the last success', () => {
    recordSysCommandTimeout(10_000);
    recordSysCommandSuccess(10_000);
    resetSysTimeouts();
    recordSysCommandTimeout(20_000);
    expect(countSysTimeoutsWithoutSuccess(60_000, 21_000)).toBe(1);
  });

  it('stays bounded under a long wedge (ring overwrites the oldest)', () => {
    for (let i = 0; i < 2000; i++) recordSysCommandTimeout(i);
    expect(countSysTimeoutsWithoutSuccess(1_000_000, 2000)).toBe(512);
  });
});
