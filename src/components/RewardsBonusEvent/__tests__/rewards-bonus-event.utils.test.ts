import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initialStartsAtValue,
  lateEnableWarning,
  nextUtcMidnight,
  resolveDisplayEnd,
  resolveDisplayStart,
  toDisplayDate,
} from '~/components/RewardsBonusEvent/rewards-bonus-event.utils';

// 2026-08-19T21:18:52.600Z is the minute the "Creator Collab Update" event was
// switched on, 21 hours after the 00:00 UTC start it already carried.
const ACTIVATION = new Date('2026-08-19T21:18:52.600Z');

// 🔴 Deliberately NOT the instant passed as `now`. Every function here takes the
// clock as a parameter, so a mutation reading the ambient clock instead would be
// invisible if the two agreed. Six years apart, it is not.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
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

describe('the display round trip', () => {
  // Asserted as a relation between calendar fields rather than against a literal,
  // so it means the same thing in every timezone the runner might use.
  it('shows the operator the UTC calendar day, whatever the local offset is', () => {
    const instant = nextUtcMidnight(ACTIVATION);
    const display = toDisplayDate(instant);

    expect([display.getFullYear(), display.getMonth(), display.getDate()]).toEqual([
      instant.getUTCFullYear(),
      instant.getUTCMonth(),
      instant.getUTCDate(),
    ]);
  });

  it('resolves back to the instant it was built from', () => {
    expect(resolveDisplayStart(toDisplayDate(nextUtcMidnight(ACTIVATION))).toISOString()).toBe(
      '2026-08-20T00:00:00.000Z'
    );
  });

  it('resolves the end field to the far end of the same UTC day', () => {
    expect(
      resolveDisplayEnd(toDisplayDate(new Date('2026-09-02T00:00:00.000Z'))).toISOString()
    ).toBe('2026-09-02T23:59:59.999Z');
  });

  // 🔴 The control that has to run in a REAL timezone. An offset-arithmetic
  // implementation (`toDisplayUTC`/`fromDisplayUTC`) is a correct-looking identity
  // at any FIXED offset — including UTC, which is what CI runs — and only slips
  // where the offset differs between the instant and the shifted value. Mocking
  // `getTimezoneOffset` to a constant cannot reach it; nor can a west-of-UTC
  // offset, because `startOf('day')` absorbs the shift inside the same UTC day.
  //
  // Sydney's 2026-10-04 is the date the old implementation turned into 2026-10-03.
  describe('across a DST start that lands on UTC midnight', () => {
    const original = process.env.TZ;

    beforeEach(() => {
      process.env.TZ = 'Australia/Sydney';
    });

    // 🔴 `delete`, not assignment. TZ is UNSET on some machines, and
    // `process.env.TZ = undefined` stores the STRING "undefined", which Node reads
    // as an invalid zone and silently resolves to UTC — leaving every later test
    // file in this worker on a different clock than it asked for.
    afterAll(() => {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    });

    it('does not slip a day when the offset changes mid-trip', () => {
      // Sunday 2026-10-04 02:00 AEST -> 03:00 AEDT, i.e. the transition sits on
      // the 2026-10-04T00:00Z boundary this default is aiming at.
      const eve = new Date('2026-10-03T12:00:00.000Z');
      const target = nextUtcMidnight(eve);

      expect(target.toISOString()).toBe('2026-10-04T00:00:00.000Z');
      expect(resolveDisplayStart(toDisplayDate(target)).toISOString()).toBe(
        '2026-10-04T00:00:00.000Z'
      );
    });

    it('has a local offset that actually moves across that boundary', () => {
      // The positive control for the block above: without a real DST shift here,
      // the assertion would hold for a broken implementation too.
      expect(new Date('2026-10-03T12:00:00.000Z').getTimezoneOffset()).not.toBe(
        new Date('2026-10-04T12:00:00.000Z').getTimezoneOffset()
      );
    });
  });
});

describe('initialStartsAtValue', () => {
  it('opens a new event on the next UTC midnight', () => {
    const value = initialStartsAtValue({ event: undefined, now: ACTIVATION });

    expect(resolveDisplayStart(value!).toISOString()).toBe('2026-08-20T00:00:00.000Z');
  });

  it('keeps the start an existing event already has', () => {
    const value = initialStartsAtValue({
      event: { id: 2, startsAt: new Date('2026-08-19T00:00:00.000Z') },
      now: ACTIVATION,
    });

    expect(resolveDisplayStart(value!).toISOString()).toBe('2026-08-19T00:00:00.000Z');
  });

  // 🔴 Event id 1 is enabled with a null start. Collapsing the three arms to two
  // would hand it a start date the moment a moderator opened it, rescheduling a
  // live event with nobody having typed anything.
  it('leaves an existing event with no start date alone', () => {
    expect(
      initialStartsAtValue({ event: { id: 1, startsAt: null }, now: ACTIVATION })
    ).toBeUndefined();
  });
});

describe('lateEnableWarning', () => {
  const past = new Date('2026-08-19T00:00:00.000Z');
  const future = new Date('2026-08-20T00:00:00.000Z');

  it('says nothing when the event is not being enabled', () => {
    expect(
      lateEnableWarning({ next: { enabled: false, startsAt: null }, now: ACTIVATION })
    ).toBeNull();
  });

  it('says nothing when enabling against a start date still to come', () => {
    expect(
      lateEnableWarning({ next: { enabled: true, startsAt: future }, now: ACTIVATION })
    ).toBeNull();
  });

  it('warns when enabling with no start date at all', () => {
    expect(lateEnableWarning({ next: { enabled: true, startsAt: null }, now: ACTIVATION })).toMatch(
      /no start date/
    );
  });

  // The incident: id 2 carried 2026-08-19T00:00:00.000Z and was enabled at 21:18
  // the same day. Do not weaken this to a null check — the start date was present
  // and correct, and the event still went live mid-day.
  it('warns when enabling against a start date earlier the same UTC day', () => {
    expect(lateEnableWarning({ next: { enabled: true, startsAt: past }, now: ACTIVATION })).toMatch(
      /already passed/
    );
  });

  // 🔴 Scoped to the transition. Warning on the resting state fires on every edit
  // of every running event, which is how the warning stops being read.
  it('says nothing when editing an event that was already live', () => {
    expect(
      lateEnableWarning({
        next: { enabled: true, startsAt: past },
        previous: { enabled: true, startsAt: past },
        now: ACTIVATION,
      })
    ).toBeNull();
  });

  it('warns when re-enabling an event that had been switched off', () => {
    expect(
      lateEnableWarning({
        next: { enabled: true, startsAt: past },
        previous: { enabled: false, startsAt: past },
        now: ACTIVATION,
      })
    ).toMatch(/already passed/);
  });

  // Enabled, but the window is behind us — `getActiveRewardsBonusEvent` picks up
  // nothing, so there is nothing to warn about.
  it('says nothing when the end date has already gone by', () => {
    expect(
      lateEnableWarning({
        next: { enabled: true, startsAt: past, endsAt: new Date('2026-08-19T12:00:00.000Z') },
        now: ACTIVATION,
      })
    ).toBeNull();
  });
});
