import { afterEach, describe, expect, it, vi } from 'vitest';

import { areLegacyStoresRemoved } from '~/server/services/apps/legacy-store-shutdown';

/**
 * The unit-test environment has no Flipt. From 2026-11-10 an unanswered flag removes the legacy
 * stores, so without the explicit OFF that `src/__tests__/setup.ts` pins, every suite exercising
 * those stores through the real flag client would start failing on that date. This pins the
 * harness, through the real `~/server/flipt/client`, at a date after the cutoff.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('legacy-store shutdown in the test environment', () => {
  it('keeps the legacy stores after the cutoff, because the setup pins the flag off', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-15T12:00:00.000Z'));

    expect(process.env.FLIPT_LOCAL_OVERRIDES).toContain('app-blocks-legacy-stores-removed=off');
    await expect(areLegacyStoresRemoved()).resolves.toBe(false);
  });
});
