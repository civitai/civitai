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

/** App Assistant on the server runner ships to moderators first; the Flipt flag widens it or turns it off. */
describe('appAssistantRemoteRunner', () => {
  afterEach(() => {
    mocks.isFliptSync.mockReset();
    mocks.isFliptSync.mockImplementation(() => null);
  });

  it('is on for a moderator and off for anyone else while Flipt has no answer', async () => {
    const mod = { id: 9411, isModerator: true, tier: 'free' } as SessionUser;
    const user = { id: 9412, isModerator: false, tier: 'gold' } as SessionUser;
    expect((await getFeatureFlagsAsync({ user: mod })).appAssistantRemoteRunner).toBe(true);
    // Control: this user does get a flag open to members, so the absence below is the declaration.
    const userFlags = await getFeatureFlagsAsync({ user });
    expect(userFlags.civitaiLink).toBe(true);
    expect(userFlags.appAssistantRemoteRunner).toBeUndefined();
  });

  it('follows its own Flipt key, off for a moderator and on for anyone else', async () => {
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
  });
});
