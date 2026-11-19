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
 * Each `ssrSignedInSkipPrefetch*` flag changes what its page server-renders for whoever has it, so
 * each ships dark for everyone, moderators included, and only its own Flipt rollout turns it on.
 */
const FLAGS = [
  ['ssrSignedInSkipPrefetch', 'ssr-signed-in-skip-prefetch'],
  ['ssrSignedInSkipPrefetchImages', 'ssr-signed-in-skip-prefetch-images'],
  ['ssrSignedInSkipPrefetchPosts', 'ssr-signed-in-skip-prefetch-posts'],
  ['ssrSignedInSkipPrefetchUser', 'ssr-signed-in-skip-prefetch-user'],
] as const;

describe.each(FLAGS.map(([flag, key], i) => ({ flag, key, i })))(
  '$flag is dark until Flipt turns it on',
  ({ flag, key, i }) => {
    afterEach(() => {
      mocks.isFliptSync.mockReset();
      mocks.isFliptSync.mockImplementation(() => null);
    });

    it('is off for a moderator and for an anonymous visitor when Flipt has no answer', async () => {
      // A different user per flag: the registry caches per user.
      const mod = { id: 9411 + 10 * i, isModerator: true, tier: 'free' } as SessionUser;
      const modFlags = await getFeatureFlagsAsync({ user: mod });
      // Control: the same moderator context does switch on a mod-available flag, so an absent flag
      // below is the declaration speaking, not a context that grants nothing.
      expect(modFlags.creatorShop).toBe(true);
      expect(modFlags[flag]).toBeUndefined();

      const anonFlags = await getFeatureFlagsAsync({ host: 'civitai.com' });
      // Control: a public flag is on for the same anonymous context.
      expect(anonFlags.canWrite).toBe(true);
      expect(anonFlags[flag]).toBeUndefined();
    });

    it('is on when its own Flipt key says so, and only it', async () => {
      // Key-aware, so a typo in `fliptKey` (the key the rollout is created under), or two flags
      // sharing one key, turns this red.
      mocks.isFliptSync.mockImplementation((k?: string) => k === key || null);
      const tester = { id: 9413 + 10 * i, isModerator: false, tier: 'free' } as SessionUser;
      const flags = await getFeatureFlagsAsync({ user: tester });
      expect(flags[flag]).toBe(true);
      for (const [other] of FLAGS) if (other !== flag) expect(flags[other]).toBeUndefined();
    });
  }
);
