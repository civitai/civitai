import { describe, expect, it } from 'vitest';
import { DEFAULT_HIDDEN_CHECKS, hiddenCheckSettings } from './config';

describe('hiddenCheckSettings', () => {
  it('falls back to the defaults when nothing is set', () => {
    expect(hiddenCheckSettings({})).toEqual(DEFAULT_HIDDEN_CHECKS);
  });

  it('takes the values the environment sets', () => {
    expect(
      hiddenCheckSettings({
        KNIGHTS_HIDDEN_CHECK_RATE: '0.2',
        KNIGHTS_HIDDEN_CHECK_FAILURE_WINDOW_HOURS: '12',
        KNIGHTS_HIDDEN_CHECK_SEVERE_DISTANCE: '3',
        KNIGHTS_HIDDEN_CHECK_SETTLE_DELAY_MINUTES: '5',
        KNIGHTS_HIDDEN_CHECK_RETIRE_MIN_ANSWERS: '40',
        KNIGHTS_HIDDEN_CHECK_RETIRE_FAILURE_RATE: '0.6',
        KNIGHTS_HIDDEN_CHECK_PROBATION_SHARE: '0.5',
      })
    ).toEqual({
      rate: 0.2,
      failureWindowHours: 12,
      severeDistance: 3,
      settleDelayMinutes: 5,
      retireMinAnswers: 40,
      retireFailureRate: 0.6,
      probationShare: 0.5,
    });
  });

  it.each([
    ['not a number', 'abc'],
    ['out of range', '2'],
    ['empty', ''],
  ])('ignores a rate that is %s', (_label, raw) => {
    expect(hiddenCheckSettings({ KNIGHTS_HIDDEN_CHECK_RATE: raw }).rate).toBe(
      DEFAULT_HIDDEN_CHECKS.rate
    );
  });

  it('serves no probation checks unless a share from 0 to 1 is set', () => {
    expect(DEFAULT_HIDDEN_CHECKS.probationShare).toBe(0);
    for (const [raw, share] of [
      ['0', 0],
      ['1', 1],
      ['0.5', 0.5],
    ] as const) {
      expect(
        hiddenCheckSettings({ KNIGHTS_HIDDEN_CHECK_PROBATION_SHARE: raw }).probationShare
      ).toBe(share);
    }
    for (const raw of ['-0.1', '1.5', 'half']) {
      expect(
        hiddenCheckSettings({ KNIGHTS_HIDDEN_CHECK_PROBATION_SHARE: raw }).probationShare
      ).toBe(0);
    }
  });
});

describe('hiddenCheckSettings with stored settings', () => {
  it('lets each stored value win over the environment, a rate of 0 included', () => {
    expect(
      hiddenCheckSettings(
        { KNIGHTS_HIDDEN_CHECK_RATE: '0.2', KNIGHTS_HIDDEN_CHECK_SEVERE_DISTANCE: '3' },
        {
          hiddenCheckRate: 0,
          hiddenCheckFailureWindowHours: 6,
          hiddenCheckSevereDistance: 1,
          hiddenCheckSettleDelayMinutes: 0,
          hiddenCheckRetireMinAnswers: 50,
          hiddenCheckRetireFailureRate: 0.8,
        }
      )
    ).toEqual({
      rate: 0,
      failureWindowHours: 6,
      severeDistance: 1,
      settleDelayMinutes: 0,
      retireMinAnswers: 50,
      retireFailureRate: 0.8,
      // Not a Config page setting: the environment's, else the default.
      probationShare: 0,
    });
  });

  it('keeps the environment, or the default, for every field nothing is stored for', () => {
    expect(
      hiddenCheckSettings({ KNIGHTS_HIDDEN_CHECK_RATE: '0.2' }, { hiddenCheckRetireMinAnswers: 50 })
    ).toEqual({ ...DEFAULT_HIDDEN_CHECKS, rate: 0.2, retireMinAnswers: 50 });
  });
});
