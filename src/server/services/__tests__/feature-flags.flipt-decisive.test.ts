import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `isFliptDecisive` tells a Flipt answer from `hasFeature`'s static fallback, so a caller that must
 * not read an outage as a refusal (the assistant runner's mints) can ask again instead. Only the
 * Flipt edge is stubbed.
 */
const { mockIsFliptSync } = vi.hoisted(() => ({ mockIsFliptSync: vi.fn() }));

vi.mock('~/server/flipt/client', () => ({
  isFliptSync: (...a: unknown[]) => mockIsFliptSync(...a),
  isFlipt: vi.fn(),
  getFliptVariant: vi.fn(),
  getFliptBoolean: vi.fn(),
  ensureFliptInitialized: vi.fn(async () => undefined),
  FLIPT_FEATURE_FLAGS: {},
}));

import type { SessionUser } from '~/types/session';
import { isFliptDecisive } from '~/server/services/feature-flags.service';

const user = { id: 303, isModerator: false, tier: 'free' } as SessionUser;

beforeEach(() => mockIsFliptSync.mockReset());

describe('isFliptDecisive', () => {
  it('is true when Flipt answers every flag, either way', async () => {
    mockIsFliptSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(await isFliptDecisive(['appBlocks', 'appAssistant'], user)).toBe(true);
    expect(mockIsFliptSync).toHaveBeenCalledWith('app-blocks-enabled', '303', expect.any(Object));
    expect(mockIsFliptSync).toHaveBeenCalledWith('app-assistant', '303', expect.any(Object));
  });

  it('is false when Flipt cannot answer one of them', async () => {
    mockIsFliptSync.mockReturnValueOnce(true).mockReturnValueOnce(null);
    expect(await isFliptDecisive(['appBlocks', 'appAssistant'], user)).toBe(false);
  });
});
