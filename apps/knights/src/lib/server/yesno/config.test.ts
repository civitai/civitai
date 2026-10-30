import { describe, expect, it } from 'vitest';
import { DEFAULT_YESNO, yesNoSettings } from './config';

describe('yesNoSettings', () => {
  it('shows yes/no questions more often than ratings unless told otherwise', () => {
    expect(yesNoSettings({})).toEqual(DEFAULT_YESNO);
    expect(DEFAULT_YESNO.share).toBeGreaterThan(0.5);
  });

  it('takes valid values, including 0 to switch them off, and ignores the rest', () => {
    expect(yesNoSettings({ KNIGHTS_YESNO_SHARE: '0', KNIGHTS_YESNO_STRETCH: '4' })).toEqual({
      share: 0,
      stretch: 4,
    });
    expect(yesNoSettings({ KNIGHTS_YESNO_SHARE: '2', KNIGHTS_YESNO_STRETCH: '1.5' })).toEqual(
      DEFAULT_YESNO
    );
    expect(yesNoSettings({ KNIGHTS_YESNO_SHARE: '', KNIGHTS_YESNO_STRETCH: 'x' })).toEqual(
      DEFAULT_YESNO
    );
  });
});
