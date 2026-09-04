import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

const ORIGINAL_TZ = process.env.TZ;

/**
 * Run a block in a named zone, and prove the pin took.
 *
 * 🔴 Every display-space assertion here is an IDENTITY at UTC, which is what CI
 * runs. Replacing `toDisplayDate` with `new Date(instant.getTime())` passes 17/17
 * under `TZ=UTC` and fails 5 under `America/Denver`. A display test that inherits
 * the runner's zone is not a weak test, it is no test.
 *
 * `delete` rather than assignment on restore: TZ is unset on some machines, and
 * `process.env.TZ = undefined` stores the STRING "undefined", which Node reads as
 * an invalid zone and resolves to UTC.
 */
function useTimezone(tz: string) {
  beforeAll(() => {
    process.env.TZ = tz;
  });

  afterAll(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  it(`is running in ${tz}`, () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(tz);
  });
}

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

// West of UTC is where the SHIFT is observable: 00:00 UTC falls on the previous
// local day, so a conversion that forgets to shift renders and saves the day
// before. East of UTC these same targets land on the same local day and every
// assertion below passes without exercising anything.
describe('the display round trip, west of UTC', () => {
  useTimezone('America/Denver');

  it('shows the operator the UTC calendar day, not the local one', () => {
    const instant = nextUtcMidnight(ACTIVATION);
    const display = toDisplayDate(instant);

    expect([display.getFullYear(), display.getMonth(), display.getDate()]).toEqual([
      instant.getUTCFullYear(),
      instant.getUTCMonth(),
      instant.getUTCDate(),
    ]);
    // The control for the zone: at UTC these are the same instant and the
    // assertion above holds for any implementation, identity included.
    expect(display.getTime()).not.toBe(instant.getTime());
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
});

// A different axis from the block above: this one catches the offset CHANGING
// mid-trip, which is what the old toDisplayUTC/fromDisplayUTC pair did across a
// DST boundary. Sydney's 2026-10-04 is the date it turned into 2026-10-03.
describe('the display round trip, across a DST start on UTC midnight', () => {
  useTimezone('Australia/Sydney');

  it('does not slip a day when the offset changes mid-trip', () => {
    // Sunday 2026-10-04 02:00 AEST -> 03:00 AEDT, i.e. the transition sits on the
    // 2026-10-04T00:00Z boundary this default aims at.
    const target = nextUtcMidnight(new Date('2026-10-03T12:00:00.000Z'));

    expect(target.toISOString()).toBe('2026-10-04T00:00:00.000Z');
    expect(resolveDisplayStart(toDisplayDate(target)).toISOString()).toBe(
      '2026-10-04T00:00:00.000Z'
    );
  });

  it('has a local offset that actually moves across that boundary', () => {
    expect(new Date('2026-10-03T12:00:00.000Z').getTimezoneOffset()).not.toBe(
      new Date('2026-10-04T12:00:00.000Z').getTimezoneOffset()
    );
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

  // Enabled, but the window is behind us, so getActiveRewardsBonusEvent picks up
  // nothing and there is nothing to warn about.
  it('says nothing when the end date has already gone by', () => {
    expect(
      lateEnableWarning({
        next: { enabled: true, startsAt: past, endsAt: new Date('2026-08-19T12:00:00.000Z') },
        now: ACTIVATION,
      })
    ).toBeNull();
  });
});
