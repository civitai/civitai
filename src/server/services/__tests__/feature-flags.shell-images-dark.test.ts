import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isFlipt: vi.fn(async () => false),
  isFliptSync: vi.fn((_key?: string): boolean | null => null),
  getFliptClientSync: vi.fn((): unknown => null),
  ensureFliptInitialized: vi.fn(async () => undefined),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: mocks.isFlipt,
  isFliptSync: mocks.isFliptSync,
  ensureFliptInitialized: mocks.ensureFliptInitialized,
  getFliptClientSync: mocks.getFliptClientSync,
}));

import type * as FliptClient from '~/server/flipt/client';
import type { SessionUser } from '~/types/session';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';

/**
 * `shellImages` gates `GET /api/page-data/images/[imageId]`. It ships dark for everyone,
 * moderators included: the moderator cohort is a Flipt rollout, so the endpoint is reachable only
 * once someone turns `shell-images` on. `['mod']` here would open it for every moderator the
 * moment the code deploys, and keep it open whenever Flipt is down.
 */
describe('shellImages is dark until Flipt turns it on', () => {
  afterEach(() => {
    mocks.isFliptSync.mockReset();
    mocks.isFliptSync.mockImplementation(() => null);
  });

  it('is off for a moderator when Flipt has no answer', async () => {
    const mod = { id: 9111, isModerator: true, tier: 'free' } as SessionUser;
    const flags = await getFeatureFlagsAsync({ user: mod });
    // Control: the same moderator context switches on a mod-available flag, so the absence below
    // is the declaration speaking, not a context that grants nothing.
    expect(flags.creatorShop).toBe(true);
    expect(flags.shellImages).toBeUndefined();
  });

  it('is on when its own Flipt key says so', async () => {
    // Key-aware, so a typo in `fliptKey` leaves the flag off and turns this red.
    mocks.isFliptSync.mockImplementation((key: string) => key === 'shell-images' || null);
    const tester = { id: 9313, isModerator: false, tier: 'free' } as SessionUser;
    const flags = await getFeatureFlagsAsync({ user: tester });
    expect(flags.shellImages).toBe(true);
  });
});
