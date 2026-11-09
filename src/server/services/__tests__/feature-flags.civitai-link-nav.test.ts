import { describe, expect, it, vi } from 'vitest';

vi.mock('~/server/flipt/client', () => ({
  isFliptSync: vi.fn(),
  isFlipt: vi.fn(),
  getFliptVariant: vi.fn(),
  getFliptBoolean: vi.fn(),
  ensureFliptInitialized: vi.fn(async () => undefined),
  FLIPT_FEATURE_FLAGS: {},
}));

import { computeUserFeatureFlagsOverlay } from '~/server/services/feature-flags.service';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

const host = {} as FeatureAccess;

describe('civitaiLinkNav', () => {
  it('is off for a user who never chose', () => {
    expect(computeUserFeatureFlagsOverlay(undefined, host).civitaiLinkNav).toBe(false);
    expect(computeUserFeatureFlagsOverlay({}, host).civitaiLinkNav).toBe(false);
  });

  it('is on once the user saved it on, and off again once saved off', () => {
    expect(computeUserFeatureFlagsOverlay({ civitaiLinkNav: true }, host).civitaiLinkNav).toBe(
      true
    );
    expect(computeUserFeatureFlagsOverlay({ civitaiLinkNav: false }, host).civitaiLinkNav).toBe(
      false
    );
  });
});
