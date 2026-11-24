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
      tagReview: false,
    });
    expect(yesNoSettings({ KNIGHTS_YESNO_SHARE: '2', KNIGHTS_YESNO_STRETCH: '1.5' })).toEqual(
      DEFAULT_YESNO
    );
    expect(yesNoSettings({ KNIGHTS_YESNO_SHARE: '', KNIGHTS_YESNO_STRETCH: 'x' })).toEqual(
      DEFAULT_YESNO
    );
  });
});

describe('yesNoSettings with stored settings', () => {
  it('lets each stored value win over the environment, a share of 0 included', () => {
    expect(
      yesNoSettings(
        { KNIGHTS_YESNO_SHARE: '0.4', KNIGHTS_YESNO_STRETCH: '5', KNIGHTS_YESNO_MAX_AGE_DAYS: '3' },
        { yesNoShare: 0, yesNoStretch: 2, yesNoMaxAgeDays: 21 }
      )
    ).toEqual({ share: 0, stretch: 2, maxAgeDays: 21, tagReview: false });
  });

  it('keeps the environment for every field nothing is stored for', () => {
    expect(
      yesNoSettings(
        { KNIGHTS_YESNO_SHARE: '0.4', KNIGHTS_YESNO_MAX_AGE_DAYS: '3' },
        { yesNoStretch: 2 }
      )
    ).toEqual({ share: 0.4, stretch: 2, maxAgeDays: 3, tagReview: false });
  });
});

describe('the tag review switch', () => {
  it('is off unless the Config page stored it on', () => {
    expect(yesNoSettings({}).tagReview).toBe(false);
    expect(yesNoSettings({}, { modTagReview: false }).tagReview).toBe(false);
    expect(yesNoSettings({}, { modTagReview: true }).tagReview).toBe(true);
  });
});
