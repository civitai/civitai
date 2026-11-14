import { afterEach, describe, expect, it } from 'vitest';
import { conversionEnabled, shopEnabled } from './runtime';

describe.each([
  ['KNIGHTS_CONVERSION_DISABLED', conversionEnabled],
  ['KNIGHTS_SHOP_DISABLED', shopEnabled],
] as const)('the %s kill switch', (name, enabled) => {
  const previous = process.env[name];
  afterEach(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });

  it('is on when unset', () => {
    delete process.env[name];
    expect(enabled()).toBe(true);
  });

  it.each(['false', '0', '', 'no'])('stays on for %j', (value) => {
    process.env[name] = value;
    expect(enabled()).toBe(true);
  });

  it.each(['true', 'TRUE', ' True ', '1', 'yes', 'on'])('turns off for %j', (value) => {
    process.env[name] = value;
    expect(enabled()).toBe(false);
  });
});
