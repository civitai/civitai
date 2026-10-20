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

/** App Assistant subagents ship to moderators first; the Flipt flag widens them or turns them off. */
describe('appAssistantSubagents', () => {
  afterEach(() => {
    mocks.isFliptSync.mockReset();
    mocks.isFliptSync.mockImplementation(() => null);
  });

  it('is on for a moderator and off for anyone else while Flipt has no answer', async () => {
    const mod = { id: 9401, isModerator: true, tier: 'free' } as SessionUser;
    const user = { id: 9402, isModerator: false, tier: 'gold' } as SessionUser;
    expect((await getFeatureFlagsAsync({ user: mod })).appAssistantSubagents).toBe(true);
    // Control: this user does get a flag open to members, so the absence below is the declaration.
    const userFlags = await getFeatureFlagsAsync({ user });
    expect(userFlags.civitaiLink).toBe(true);
    expect(userFlags.appAssistantSubagents).toBeUndefined();
  });

  it('follows its own Flipt key, off for a moderator and on for anyone else', async () => {
    mocks.isFliptSync.mockImplementation((key?: string) =>
      key === 'app-assistant-subagents' ? false : null
    );
    const mod = { id: 9403, isModerator: true, tier: 'free' } as SessionUser;
    expect((await getFeatureFlagsAsync({ user: mod })).appAssistantSubagents).toBeUndefined();

    mocks.isFliptSync.mockImplementation((key?: string) =>
      key === 'app-assistant-subagents' ? true : null
    );
    const user = { id: 9404, isModerator: false, tier: 'free' } as SessionUser;
    expect((await getFeatureFlagsAsync({ user })).appAssistantSubagents).toBe(true);
  });
});
