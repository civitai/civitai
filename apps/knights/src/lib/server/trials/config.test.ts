import { describe, expect, it } from 'vitest';
import { HARVEST, harvestSettings } from './config';

describe('harvestSettings', () => {
  it('runs when unset, on, true or 1, in any case', () => {
    for (const value of [undefined, '', ' ON ', 'true', 'TRUE', '1']) {
      expect(harvestSettings({ KNIGHTS_HARVEST: value })).toMatchObject({ paused: false });
      expect(harvestSettings({ KNIGHTS_HARVEST: value }).unrecognized).toBeUndefined();
    }
  });

  it('pauses on off, false or 0', () => {
    for (const value of ['off', ' OFF ', 'false', '0']) {
      expect(harvestSettings({ KNIGHTS_HARVEST: value })).toMatchObject({ paused: true });
      expect(harvestSettings({ KNIGHTS_HARVEST: value }).unrecognized).toBeUndefined();
    }
  });

  it('pauses on anything else, and names the value so it can be reported', () => {
    for (const value of ['paused', 'of', 'yes', '2']) {
      expect(harvestSettings({ KNIGHTS_HARVEST: value })).toMatchObject({
        paused: true,
        unrecognized: value,
      });
    }
  });

  it('takes a hidden-check share between 0 and 1, and the default otherwise', () => {
    expect(harvestSettings({ KNIGHTS_HARVEST_HIDDEN_CHECK_SHARE: '0.3' }).hiddenCheckShare).toBe(
      0.3
    );
    expect(harvestSettings({ KNIGHTS_HARVEST_HIDDEN_CHECK_SHARE: '1' }).hiddenCheckShare).toBe(1);
    expect(harvestSettings({ KNIGHTS_HARVEST_HIDDEN_CHECK_SHARE: '0' }).hiddenCheckShare).toBe(0);
    for (const value of [undefined, '', 'abc', '-0.1', '1.5', '30']) {
      expect(harvestSettings({ KNIGHTS_HARVEST_HIDDEN_CHECK_SHARE: value }).hiddenCheckShare).toBe(
        HARVEST.hiddenCheckShare
      );
    }
  });
});
