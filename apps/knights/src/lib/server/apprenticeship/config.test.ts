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
