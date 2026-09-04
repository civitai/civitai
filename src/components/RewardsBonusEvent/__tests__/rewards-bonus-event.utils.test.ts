import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  defaultStartsAtValue,
  lateEnableWarning,
  nextUtcMidnight,
  resolveDisplayStart,
} from '~/components/RewardsBonusEvent/rewards-bonus-event.utils';

// 2026-08-19T21:18:52.600Z is the minute the "Creator Collab Update" event was
// switched on, 21 hours after the 00:00 UTC start it already carried. Using the
// real instant keeps the tests anchored to the thing they exist to prevent.
const ACTIVATION = new Date('2026-08-19T21:18:52.600Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(ACTIVATION);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('nextUtcMidnight', () => {
  it('lands on the next UTC day, not the current one', () => {
    expect(nextUtcMidnight(ACTIVATION).toISOString()).toBe('2026-08-20T00:00:00.000Z');
  });

  it('still moves forward a whole day when called exactly at midnight', () => {
    expect(nextUtcMidnight(new Date('2026-08-19T00:00:00.000Z')).toISOString()).toBe(
      '2026-08-20T00:00:00.000Z'
    );
  });
});

describe('defaultStartsAtValue', () => {
  // 🔴 Pin a non-zero UTC offset rather than trusting the runner's. The whole
  // display-space shift is a no-op at UTC, so on a UTC box (which is what CI is)
  // these assertions hold for any implementation and prove nothing. UTC-5.
  const OFFSET_MINUTES = 300;

  beforeEach(() => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(OFFSET_MINUTES);
  });

  // The control for the pin above: if the offset were not being applied, the
  // display value would equal the instant and the round-trip below would pass
  // without exercising the shift at all.
  it('is shifted away from the instant it represents', () => {
    expect(defaultStartsAtValue(ACTIVATION).getTime()).toBe(
      new Date('2026-08-20T00:00:00.000Z').getTime() + OFFSET_MINUTES * 60_000
    );
  });

  // The picker value is shifted into display space and `handleSubmit` shifts it
  // back. If the two disagree the default silently saves the wrong day, which is
  // invisible in the UI because the picker renders the shifted value.
  it('round-trips through the submit path to the next UTC midnight', () => {
    expect(resolveDisplayStart(defaultStartsAtValue(ACTIVATION)).toISOString()).toBe(
      '2026-08-20T00:00:00.000Z'
    );
  });
});

describe('lateEnableWarning', () => {
  const future = defaultStartsAtValue(ACTIVATION);

  it('says nothing when the event is not being enabled', () => {
    expect(lateEnableWarning({ enabled: false, startsAt: null, now: ACTIVATION })).toBeNull();
  });

  it('says nothing when enabling against a start date still to come', () => {
    expect(lateEnableWarning({ enabled: true, startsAt: future, now: ACTIVATION })).toBeNull();
  });

  it('warns when enabling with no start date at all', () => {
    // The shape of RewardsBonusEvent id 1, which is `enabled` with a null start.
    expect(lateEnableWarning({ enabled: true, startsAt: null, now: ACTIVATION })).toMatch(
      /no start date/
    );
  });

  // 🔴 The case this whole file exists for: id 2 carried 2026-08-19T00:00:00.000Z
  // and was enabled at 21:18 the same day. Do not weaken this to a null check —
  // the start date was present and correct, and the event still went live mid-day.
  it('warns when enabling against a start date earlier the same UTC day', () => {
    const startOfToday = defaultStartsAtValue(new Date('2026-08-18T12:00:00.000Z'));

    expect(resolveDisplayStart(startOfToday).toISOString()).toBe('2026-08-19T00:00:00.000Z');
    expect(lateEnableWarning({ enabled: true, startsAt: startOfToday, now: ACTIVATION })).toMatch(
      /already passed/
    );
  });
});
