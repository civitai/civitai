import { describe, expect, it } from 'vitest';
import { HARVEST, harvestSettings } from './config';

describe('harvestSettings', () => {
  it('runs only when unset or on, so a mistyped value pauses rather than runs', () => {
    for (const value of [undefined, '', ' ON ']) {
      expect(harvestSettings({ KNIGHTS_HARVEST: value }).paused).toBe(false);
    }
    for (const value of ['off', ' OFF ', 'false', '0', 'paused', 'of']) {
      expect(harvestSettings({ KNIGHTS_HARVEST: value }).paused).toBe(true);
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
