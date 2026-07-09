import { describe, expect, it } from 'vitest';
import {
  POLL_BUDGET_MS,
  POLL_SCHEDULE_MS,
  classifyAttachResult,
  nextPollDelay,
  shouldKeepPolling,
} from '~/components/Apps/assetPolling';

/**
 * W13 P3a — off-site asset-attach AUTO-POLL decision logic. Pins the backoff
 * schedule, the terminal-on-error / terminal-on-success classification, and the
 * timeout-after-budget behaviour so the poll loop is provable WITHOUT mounting the
 * component or faking timers.
 */

describe('classifyAttachResult', () => {
  it('null (resolved) → attached (terminal)', () => {
    expect(classifyAttachResult(null)).toEqual({ kind: 'attached' });
  });

  it('CONFLICT code → scanning (retriable)', () => {
    expect(
      classifyAttachResult({
        code: 'CONFLICT',
        message: 'image is not approved for publishing (scan is not complete)',
      })
    ).toEqual({ kind: 'scanning' });
  });

  it('BAD_REQUEST code → error (terminal) carrying the human message', () => {
    expect(
      classifyAttachResult({
        code: 'BAD_REQUEST',
        message: "that image couldn't be imported — upload it manually instead",
      })
    ).toEqual({
      kind: 'error',
      message: "that image couldn't be imported — upload it manually instead",
    });
  });

  it('BAD_REQUEST (blocked) → error (terminal)', () => {
    expect(
      classifyAttachResult({
        code: 'BAD_REQUEST',
        message: 'that image was rejected during scanning — choose a different image',
      }).kind
    ).toBe('error');
  });

  it('an undefined / unknown code → error (terminal, fail-safe)', () => {
    expect(
      classifyAttachResult({ code: undefined, message: 'Image was blocked (NSFW)' })
    ).toEqual({ kind: 'error', message: 'Image was blocked (NSFW)' });
  });

  // REGRESSION GUARD: prose no longer drives the decision. The decision reads the
  // structural tRPC code, so a retriable response whose human message has been
  // COMPLETELY REWORDED (no "scan is not complete" anywhere) still classifies as
  // `scanning` — the old regex would have mis-classified this as a terminal error
  // and stopped polling. Conversely a reworded message that HAPPENS to sound
  // retriable does NOT flip a BAD_REQUEST into scanning.
  it('a reworded message does not change the classification (code-driven, not prose)', () => {
    // Reworded retriable message, still CONFLICT → scanning.
    expect(
      classifyAttachResult({
        code: 'CONFLICT',
        message: 'hang tight — your picture is still being checked',
      }).kind
    ).toBe('scanning');
    // Reworded terminal message that sounds like "scanning", still BAD_REQUEST → error.
    expect(
      classifyAttachResult({
        code: 'BAD_REQUEST',
        message: 'scan is not complete (but this is terminal)',
      }).kind
    ).toBe('error');
  });
});

describe('nextPollDelay — backoff schedule', () => {
  it('returns each scheduled delay in order for early attempts', () => {
    expect(nextPollDelay(0)).toBe(POLL_SCHEDULE_MS[0]);
    expect(nextPollDelay(1)).toBe(POLL_SCHEDULE_MS[1]);
    expect(nextPollDelay(2)).toBe(POLL_SCHEDULE_MS[2]);
  });

  it('reuses the LAST schedule entry for attempts past the array (until budget)', () => {
    const last = POLL_SCHEDULE_MS[POLL_SCHEDULE_MS.length - 1];
    // Just past the array end, still within budget → the last (repeated) value.
    expect(nextPollDelay(POLL_SCHEDULE_MS.length)).toBe(last);
  });

  it('is front-loaded then eased out (non-decreasing early delays)', () => {
    for (let i = 1; i < POLL_SCHEDULE_MS.length; i++) {
      expect(POLL_SCHEDULE_MS[i]).toBeGreaterThanOrEqual(POLL_SCHEDULE_MS[i - 1]);
    }
  });

  it('returns null once the cumulative budget would be exceeded (timeout)', () => {
    // Walk attempts until it gives up; the sum of granted delays must not exceed budget.
    let attempt = 0;
    let total = 0;
    let delay = nextPollDelay(attempt);
    while (delay !== null) {
      total += delay;
      attempt++;
      delay = nextPollDelay(attempt);
      // Safety valve so a bug can't infinite-loop the test.
      if (attempt > 10000) break;
    }
    expect(delay).toBeNull();
    expect(total).toBeLessThanOrEqual(POLL_BUDGET_MS);
    // And the whole window is in the intended ~2–3 min ballpark.
    expect(total).toBeGreaterThanOrEqual(120000);
  });

  it('rejects a negative / non-finite attempt with null', () => {
    expect(nextPollDelay(-1)).toBeNull();
    expect(nextPollDelay(Number.NaN)).toBeNull();
  });

  it('honours a custom schedule + budget (pure, injectable)', () => {
    const schedule = [10, 20];
    const budget = 45;
    expect(nextPollDelay(0, schedule, budget)).toBe(10); // cum 0 + 10 ≤ 45
    expect(nextPollDelay(1, schedule, budget)).toBe(20); // cum 10 + 20 ≤ 45
    // attempt 2 reuses last (20); cum 10+20=30, +20=50 > 45 → give up.
    expect(nextPollDelay(2, schedule, budget)).toBeNull();
  });

  it('an empty schedule gives up immediately', () => {
    expect(nextPollDelay(0, [], 1000)).toBeNull();
  });
});

describe('shouldKeepPolling', () => {
  it('keeps polling on a scanning outcome within budget, returning the delay', () => {
    expect(shouldKeepPolling({ kind: 'scanning' }, 0)).toEqual({
      keep: true,
      delayMs: POLL_SCHEDULE_MS[0],
    });
  });

  it('STOPS on an attached outcome (terminal, no delay)', () => {
    expect(shouldKeepPolling({ kind: 'attached' }, 0)).toEqual({ keep: false });
  });

  it('STOPS on an error outcome (terminal — blocked/NSFW)', () => {
    expect(shouldKeepPolling({ kind: 'error', message: 'blocked' }, 0)).toEqual({ keep: false });
  });

  it('STOPS on a scanning outcome once the budget is exhausted (→ timeout)', () => {
    const schedule = [10];
    const budget = 15;
    // attempt 0 fits (10 ≤ 15); attempt 1 would be 10+10=20 > 15 → stop.
    expect(shouldKeepPolling({ kind: 'scanning' }, 0, schedule, budget)).toEqual({
      keep: true,
      delayMs: 10,
    });
    expect(shouldKeepPolling({ kind: 'scanning' }, 1, schedule, budget)).toEqual({ keep: false });
  });
});
