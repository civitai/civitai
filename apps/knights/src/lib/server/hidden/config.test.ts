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
      })
    ).toEqual({ rate: 0.2, failureWindowHours: 12, severeDistance: 3 });
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
});
