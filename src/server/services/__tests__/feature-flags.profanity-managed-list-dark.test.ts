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
import { browserChecksProfanity } from '~/components/Search/search-refusal';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';

/**
 * `profanityManagedList` tells the browser the server enforces the managed profanity list, and the
 * browser then leaves search checks to it. With no answer from Flipt (key absent, Flipt down) it must
 * read off, so the browser runs its own check: on would skip a check the server is not running.
 */
describe('profanityManagedList is off, and the browser checks, until Flipt turns it on', () => {
  const checksSiteSearch = (flag: boolean | undefined) =>
    browserChecksProfanity({ serverProfanity: !!flag, via: 'siteSearch', proxyEnabled: true });

  afterEach(() => {
    mocks.isFliptSync.mockReset();
    mocks.isFliptSync.mockImplementation(() => null);
  });

  it('is off for a moderator and for an anonymous visitor when Flipt has no answer', async () => {
    const mod = { id: 9711, isModerator: true, tier: 'free' } as SessionUser;
    const modFlags = await getFeatureFlagsAsync({ user: mod });
    // Control: the same moderator context does switch on a mod-available flag.
    expect(modFlags.creatorShop).toBe(true);
    expect(checksSiteSearch(modFlags.profanityManagedList)).toBe(true);

    const anonFlags = await getFeatureFlagsAsync({ host: 'civitai.com' });
    expect(anonFlags.canWrite).toBe(true);
    expect(checksSiteSearch(anonFlags.profanityManagedList)).toBe(true);
  });

  it('is on when its own Flipt key says so, and the browser then leaves the check to the server', async () => {
    // Key-aware, so a typo in `fliptKey` turns this red.
    mocks.isFliptSync.mockImplementation(
      (key?: string) => key === 'profanity-managed-list' || null
    );
    const member = { id: 9713, isModerator: false, tier: 'free' } as SessionUser;
    const flags = await getFeatureFlagsAsync({ user: member });
    expect(flags.profanityManagedList).toBe(true);
    expect(checksSiteSearch(flags.profanityManagedList)).toBe(false);
  });
});
