import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BackoffRetry,
  getBackoffDelay,
  HUB_CONNECT_BACKOFF,
  TOKEN_FETCH_RETRY_BACKOFF,
  TOKEN_REFRESH_BACKOFF,
} from '~/utils/signals/backoff';

// Fixture bounds chosen so no ceiling equals `minMs` or another ceiling, and the cap is not a
// power-of-two multiple of the base: a mutant that drops the cap, the floor or the doubling
// produces a value these literals cannot match.
const CONFIG = { baseMs: 1_000, capMs: 10_000, minMs: 100 };
const fixed = (value: number) => () => value;

describe('getBackoffDelay', () => {
  it('doubles the ceiling per attempt and stops at the cap', () => {
    const top = [0, 1, 2, 3, 4, 5, 10].map((n) => getBackoffDelay(n, CONFIG, fixed(1)));
    expect(top).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000]);
  });

  it('never goes below the floor', () => {
    expect([0, 3, 50].map((n) => getBackoffDelay(n, CONFIG, fixed(0)))).toEqual([100, 100, 100]);
  });

  it('spreads the delay uniformly between the floor and the ceiling', () => {
    // attempt 2: ceiling 4000 → 100 + r * 3900
    expect([0.25, 0.5, 0.75].map((r) => getBackoffDelay(2, CONFIG, fixed(r)))).toEqual([
      1_075, 2_050, 3_025,
    ]);
  });

  it('stays finite and capped for an outage long enough to overflow 2^attempt', () => {
    expect(getBackoffDelay(5_000, CONFIG, fixed(1))).toBe(10_000);
  });

  it('defaults to Math.random', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(getBackoffDelay(0, CONFIG)).toBe(550);
    vi.restoreAllMocks();
  });

  // The production numbers the PR description quotes; a change to them should be deliberate.
  it.each([
    ['hub connect', HUB_CONNECT_BACKOFF, [3_000, 6_000, 12_000, 24_000, 48_000, 96_000, 180_000]],
    ['token refresh', TOKEN_REFRESH_BACKOFF, [30_000, 60_000, 120_000, 240_000, 480_000, 600_000]],
    ['token fetch retry', TOKEN_FETCH_RETRY_BACKOFF, [4_000, 8_000, 16_000, 32_000, 60_000]],
  ])('%s schedule ceilings', (_name, config, expected) => {
    expect(expected.map((_, n) => getBackoffDelay(n, config, fixed(1)))).toEqual(expected);
  });
});

describe('BackoffRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A retry whose every attempt fails, recording when it ran. */
  function failingRetry(random = 1) {
    const runs: number[] = [];
    const retry: BackoffRetry = new BackoffRetry(
      () => {
        runs.push(Date.now());
        retry.failed();
      },
      CONFIG,
      fixed(random)
    );
    return { retry, runs };
  }

  it('runs immediately when nothing has failed', () => {
    const { retry, runs } = failingRetry();
    retry.request();
    expect(runs).toEqual([0]);
  });

  it('retries on the growing schedule, up to the cap', () => {
    const { retry, runs } = failingRetry();
    retry.request();
    vi.advanceTimersByTime(60_000);
    // gaps 1s, 2s, 4s, 8s, then 10s capped
    expect(runs.slice(0, 8)).toEqual([0, 1_000, 3_000, 7_000, 15_000, 25_000, 35_000, 45_000]);
  });

  it('a request while a retry is pending does not add an attempt', () => {
    const { retry, runs } = failingRetry();
    retry.request();
    retry.request();
    retry.request();
    vi.advanceTimersByTime(999);
    expect(runs).toEqual([0]);
  });

  it('a request after failures waits for the schedule instead of running now', () => {
    let fail = true;
    const runs: number[] = [];
    const retry: BackoffRetry = new BackoffRetry(
      () => {
        runs.push(Date.now());
        if (fail) retry.failed();
      },
      CONFIG,
      fixed(1)
    );
    retry.request(); // fails at 0
    fail = false;
    vi.advanceTimersByTime(1_000); // the retry at 1s works, but nobody has called succeeded() yet
    expect(runs).toEqual([0, 1_000]);
    // e.g. a connection that is up but not yet stable: the failure count still stands
    retry.request();
    expect(runs).toEqual([0, 1_000]);
    vi.advanceTimersByTime(1_000); // the 1st step again: ceiling 1s
    expect(runs).toEqual([0, 1_000, 2_000]);
  });

  it('succeeded() resets the schedule to the first step', () => {
    const { retry, runs } = failingRetry();
    retry.request();
    vi.advanceTimersByTime(30_000);
    retry.succeeded();
    expect(retry.getStatus()).toEqual({ failures: 0, nextAttemptAt: null });

    const before = runs.length;
    vi.advanceTimersByTime(60_000);
    expect(runs).toHaveLength(before); // the pending retry was cancelled
    retry.request();
    vi.advanceTimersByTime(1_000);
    expect(runs.slice(before)).toEqual([90_000, 91_000]);
  });

  it('reset() lets the next request run immediately', () => {
    const { retry, runs } = failingRetry();
    retry.request();
    vi.advanceTimersByTime(20_000); // a 10s retry is pending
    retry.reset();
    retry.request();
    expect(runs.at(-1)).toBe(20_000);
  });

  it('reports when the next attempt is due', () => {
    const { retry } = failingRetry(0.5);
    retry.request(); // fails at 0, schedules step 0: 100 + 0.5 * 900
    expect(retry.getStatus()).toEqual({ failures: 1, nextAttemptAt: 550 });
  });
});
