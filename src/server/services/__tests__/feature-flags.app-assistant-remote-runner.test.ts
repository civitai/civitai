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

/** App Assistant on the server runner is dark until its Flipt flag turns it on, mods included. */
describe('appAssistantRemoteRunner', () => {
  afterEach(() => {
    mocks.isFliptSync.mockReset();
    mocks.isFliptSync.mockImplementation(() => null);
  });

  it('is off for everyone, moderators included, while Flipt has no answer (down or no flag yet)', async () => {
    const mod = { id: 9411, isModerator: true, tier: 'free' } as SessionUser;
    const user = { id: 9412, isModerator: false, tier: 'gold' } as SessionUser;
    const modFlags = await getFeatureFlagsAsync({ user: mod });
    // Control: a moderator does get a mod-only flag, so the absence below is this flag's own rule.
    expect(modFlags.appAssistantSubagents).toBe(true);
    expect(modFlags.appAssistantRemoteRunner).toBeUndefined();
    expect((await getFeatureFlagsAsync({ user })).appAssistantRemoteRunner).toBeUndefined();
  });

  it('follows its own Flipt key: on for whom it says, off when it says so', async () => {
    mocks.isFliptSync.mockImplementation((key?: string) =>
      key === 'app-assistant-remote-runner' ? false : null
    );
    const mod = { id: 9413, isModerator: true, tier: 'free' } as SessionUser;
    expect((await getFeatureFlagsAsync({ user: mod })).appAssistantRemoteRunner).toBeUndefined();

    mocks.isFliptSync.mockImplementation((key?: string) =>
      key === 'app-assistant-remote-runner' ? true : null
    );
    const user = { id: 9414, isModerator: false, tier: 'free' } as SessionUser;
    expect((await getFeatureFlagsAsync({ user })).appAssistantRemoteRunner).toBe(true);
    const mod2 = { id: 9415, isModerator: true, tier: 'free' } as SessionUser;
    expect((await getFeatureFlagsAsync({ user: mod2 })).appAssistantRemoteRunner).toBe(true);
  });
});
