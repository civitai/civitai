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
      playerDefault: false,
      reportThreshold: 5,
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
    ).toEqual({
      share: 0,
      stretch: 2,
      maxAgeDays: 21,
      tagReview: false,
      playerDefault: false,
      reportThreshold: 5,
    });
  });

  it('keeps the environment for every field nothing is stored for', () => {
    expect(
      yesNoSettings(
        { KNIGHTS_YESNO_SHARE: '0.4', KNIGHTS_YESNO_MAX_AGE_DAYS: '3' },
        { yesNoStretch: 2 }
      )
    ).toEqual({
      share: 0.4,
      stretch: 2,
      maxAgeDays: 3,
      tagReview: false,
      playerDefault: false,
      reportThreshold: 5,
    });
  });
});

describe('the tag review switch', () => {
  it('is off unless the Config page stored it on', () => {
    expect(yesNoSettings({}).tagReview).toBe(false);
    expect(yesNoSettings({}, { modTagReview: false }).tagReview).toBe(false);
    expect(yesNoSettings({}, { modTagReview: true }).tagReview).toBe(true);
  });
});

describe('the default for players who never set the questions switch', () => {
  it('is off unless the environment or the Config page turns it on', () => {
    expect(yesNoSettings({}).playerDefault).toBe(false);
    expect(yesNoSettings({ KNIGHTS_YESNO_PLAYER_DEFAULT: 'yes' }).playerDefault).toBe(false);
    expect(yesNoSettings({ KNIGHTS_YESNO_PLAYER_DEFAULT: ' ON ' }).playerDefault).toBe(true);
  });

  it('takes the stored value over the environment, off included', () => {
    expect(
      yesNoSettings({ KNIGHTS_YESNO_PLAYER_DEFAULT: 'on' }, { yesNoPlayerDefault: false }).playerDefault
    ).toBe(false);
    expect(yesNoSettings({}, { yesNoPlayerDefault: true }).playerDefault).toBe(true);
  });
});

describe('the report threshold', () => {
  it('pulls a question at 5 distinct reporters unless told otherwise', () => {
    expect(DEFAULT_YESNO.reportThreshold).toBe(5);
    expect(yesNoSettings({}).reportThreshold).toBe(5);
  });

  it('takes a whole number above 0 from the environment, and the stored value over it', () => {
    expect(yesNoSettings({ KNIGHTS_YESNO_REPORT_THRESHOLD: '3' }).reportThreshold).toBe(3);
    for (const raw of ['0', '-1', '2.5', 'x', ''])
      expect(yesNoSettings({ KNIGHTS_YESNO_REPORT_THRESHOLD: raw }).reportThreshold).toBe(5);
    expect(
      yesNoSettings({ KNIGHTS_YESNO_REPORT_THRESHOLD: '3' }, { yesNoReportThreshold: 8 })
        .reportThreshold
    ).toBe(8);
  });
});
