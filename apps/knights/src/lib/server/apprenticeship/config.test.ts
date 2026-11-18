import { describe, expect, it } from 'vitest';
import { apprenticeSettings } from './config';

describe('apprenticeSettings', () => {
  it('switches smites off only for "off", in any case or padding', () => {
    for (const value of ['off', 'OFF', ' Off ']) {
      expect(apprenticeSettings({ KNIGHTS_APPRENTICE_SMITES: value }).smites).toBe(false);
    }
  });

  it('keeps smites on when unset, empty or anything else', () => {
    expect(apprenticeSettings({}).smites).toBe(true);
    for (const value of ['', 'on', 'of', 'offf', 'false', '0']) {
      expect(apprenticeSettings({ KNIGHTS_APPRENTICE_SMITES: value }).smites).toBe(true);
    }
  });
});

describe('apprenticeSettings with stored settings', () => {
  it('lets the stored switch win over the environment either way', () => {
    expect(
      apprenticeSettings({ KNIGHTS_APPRENTICE_SMITES: 'off' }, { apprenticeSmites: true })
    ).toEqual({
      smites: true,
    });
    expect(apprenticeSettings({}, { apprenticeSmites: false })).toEqual({ smites: false });
  });

  it('keeps the environment when nothing is stored', () => {
    expect(apprenticeSettings({ KNIGHTS_APPRENTICE_SMITES: 'off' }, {}).smites).toBe(false);
  });
});
