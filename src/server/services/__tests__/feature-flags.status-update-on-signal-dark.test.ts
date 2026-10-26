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
 * `statusUpdateOnSignal` changes how often every generator page reads its running workflows, so it
 * ships dark for everyone, moderators included, and only its own Flipt key turns it on.
 */
describe('statusUpdateOnSignal is dark until Flipt turns it on', () => {
  afterEach(() => {
    mocks.isFliptSync.mockReset();
    mocks.isFliptSync.mockImplementation(() => null);
  });

  it('is off for a moderator and for an anonymous visitor when Flipt has no answer', async () => {
    const mod = { id: 9611, isModerator: true, tier: 'free' } as SessionUser;
    const modFlags = await getFeatureFlagsAsync({ user: mod });
    // Control: the same context switches on a mod-available flag.
    expect(modFlags.creatorShop).toBe(true);
    expect(modFlags.statusUpdateOnSignal).toBeUndefined();

    const anonFlags = await getFeatureFlagsAsync({ host: 'civitai.com' });
    expect(anonFlags.canWrite).toBe(true);
    expect(anonFlags.statusUpdateOnSignal).toBeUndefined();
  });

  it('is on when its own Flipt key says so', async () => {
    mocks.isFliptSync.mockImplementation(
      (key: string) => key === 'status-update-on-signal' || null
    );
    const tester = { id: 9612, isModerator: false, tier: 'free' } as SessionUser;
    const flags = await getFeatureFlagsAsync({ user: tester });
    expect(flags.statusUpdateOnSignal).toBe(true);
  });
});
