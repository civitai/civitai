import { describe, expect, it } from 'vitest';
import { DEFAULT_YESNO, yesNoSettings } from './config';

describe('yesNoSettings', () => {
  it('ages out answered questions after two weeks unless told otherwise', () => {
    expect(DEFAULT_YESNO.maxAgeDays).toBe(14);
    expect(yesNoSettings({ KNIGHTS_YESNO_MAX_AGE_DAYS: '0' }).maxAgeDays).toBe(14);
  });

  it('shows yes/no questions more often than ratings unless told otherwise', () => {
    expect(yesNoSettings({})).toEqual(DEFAULT_YESNO);
    expect(DEFAULT_YESNO.share).toBeGreaterThan(0.5);
  });

  it('takes valid values, including 0 to switch them off, and ignores the rest', () => {
    expect(
      yesNoSettings({
        KNIGHTS_YESNO_SHARE: '0',
        KNIGHTS_YESNO_STRETCH: '4',
        KNIGHTS_YESNO_MAX_AGE_DAYS: '30',
      })
    ).toEqual({
      share: 0,
      stretch: 4,
      maxAgeDays: 30,
    });
    expect(yesNoSettings({ KNIGHTS_YESNO_SHARE: '2', KNIGHTS_YESNO_STRETCH: '1.5' })).toEqual(
      DEFAULT_YESNO
    );
    expect(yesNoSettings({ KNIGHTS_YESNO_SHARE: '', KNIGHTS_YESNO_STRETCH: 'x' })).toEqual(
      DEFAULT_YESNO
    );
  });
});
