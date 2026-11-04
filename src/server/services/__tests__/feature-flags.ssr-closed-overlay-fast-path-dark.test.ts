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
 * `ssrClosedOverlayFastPath` changes how every Tooltip, Popover, Menu and HoverCard in the app
 * mounts, so it ships dark for everyone, moderators included, and only the
 * `ssr-closed-overlay-fast-path` Flipt rollout turns it on. `['mod']` would switch it on for every
 * moderator the moment the code deploys; `['public']` would switch it on for everyone whenever
 * Flipt is unreachable.
 */
describe('ssrClosedOverlayFastPath is dark until Flipt turns it on', () => {
  const mod = { id: 9611, isModerator: true, tier: 'free' } as SessionUser;

  afterEach(() => {
    mocks.isFliptSync.mockReset();
    mocks.isFliptSync.mockImplementation(() => null);
  });

  it('is off for a moderator and for an anonymous visitor when Flipt has no answer', async () => {
    const modFlags = await getFeatureFlagsAsync({ user: mod });
    // Control: the same moderator context does switch on a mod-available flag.
    expect(modFlags.creatorShop).toBe(true);
    expect(modFlags.ssrClosedOverlayFastPath).toBeUndefined();

    const anonFlags = await getFeatureFlagsAsync({ host: 'civitai.com' });
    // Control: a public flag is on for the same anonymous context.
    expect(anonFlags.canWrite).toBe(true);
    expect(anonFlags.ssrClosedOverlayFastPath).toBeUndefined();
  });

  it('is on when its own Flipt key says so', async () => {
    // Key-aware, so a typo in `fliptKey` (the key the rollout is created under) turns this red.
    mocks.isFliptSync.mockImplementation(
      (key?: string) => key === 'ssr-closed-overlay-fast-path' || null
    );
    // A different user: the registry caches per user.
    const tester = { id: 9613, isModerator: false, tier: 'free' } as SessionUser;
    const flags = await getFeatureFlagsAsync({ user: tester });
    expect(flags.ssrClosedOverlayFastPath).toBe(true);
  });
});
