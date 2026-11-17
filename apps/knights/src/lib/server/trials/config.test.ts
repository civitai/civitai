import { describe, expect, it } from 'vitest';
import { harvestSettings } from './config';

describe('harvestSettings', () => {
  it('pauses only on off, in any case', () => {
    expect(harvestSettings({ KNIGHTS_HARVEST: ' OFF ' }).paused).toBe(true);
    for (const value of [undefined, '', 'on', 'of']) {
      expect(harvestSettings({ KNIGHTS_HARVEST: value }).paused).toBe(false);
    }
  });

  it('takes a hidden-check share between 0 and 1, and 0 otherwise', () => {
    expect(harvestSettings({ KNIGHTS_HARVEST_HIDDEN_CHECK_SHARE: '0.3' }).hiddenCheckShare).toBe(
      0.3
    );
    expect(harvestSettings({ KNIGHTS_HARVEST_HIDDEN_CHECK_SHARE: '1' }).hiddenCheckShare).toBe(1);
    for (const value of [undefined, '', 'abc', '-0.1', '1.5']) {
      expect(harvestSettings({ KNIGHTS_HARVEST_HIDDEN_CHECK_SHARE: value }).hiddenCheckShare).toBe(
        0
      );
    }
  });
});
