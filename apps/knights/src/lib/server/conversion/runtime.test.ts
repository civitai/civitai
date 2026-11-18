import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredSettings } from '../settings/stored';

const stored = vi.hoisted(() => ({ current: {} as StoredSettings }));
vi.mock('../settings/runtime', () => ({ storedSettings: async () => stored.current }));

import { conversionEnabled, shopEnabled } from './runtime';

describe.each([
  ['KNIGHTS_CONVERSION_DISABLED', 'conversionDisabled', conversionEnabled],
  ['KNIGHTS_SHOP_DISABLED', 'shopDisabled', shopEnabled],
] as const)('the %s kill switch', (name, field, enabled) => {
  const previous = process.env[name];
  beforeEach(() => (stored.current = {}));
  afterEach(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });

  it('is on when unset', async () => {
    delete process.env[name];
    expect(await enabled()).toBe(true);
  });

  it.each(['false', '0', '', 'no'])('stays on for %j', async (value) => {
    process.env[name] = value;
    expect(await enabled()).toBe(true);
  });

  it.each(['true', 'TRUE', ' True ', '1', 'yes', 'on'])('turns off for %j', async (value) => {
    process.env[name] = value;
    expect(await enabled()).toBe(false);
  });

  it('follows the switch saved on the moderator page over the environment, either way', async () => {
    process.env[name] = 'true';
    stored.current = { [field]: false };
    expect(await enabled()).toBe(true);
    delete process.env[name];
    stored.current = { [field]: true };
    expect(await enabled()).toBe(false);
  });
});
