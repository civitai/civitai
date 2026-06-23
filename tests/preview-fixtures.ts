import path from 'path';

/**
 * Shared fixtures for the preview smoke tests. NOT a test file (Playwright
 * forbids test files importing each other), so the setup + spec both import
 * from here. Matched by the default config's `**\/preview-*.ts` testIgnore and
 * excluded from the preview config's testMatch, so Playwright never treats it
 * as a test.
 */

export type PreviewRole = 'mod' | 'tester' | 'gold' | 'restricted';

// Must mirror datapacket-talos seed-smoke-test-users.yaml (fixed reserved ids)
// and the flipt-state `testers` allowlist (tester + gold).
export const PREVIEW_USERS: Record<
  PreviewRole,
  { id: number; username: string; isModerator: boolean; tier?: 'gold' }
> = {
  mod: { id: 2000000001, username: 'ci-smoke-mod', isModerator: true },
  tester: { id: 2000000002, username: 'ci-smoke-tester', isModerator: false },
  gold: { id: 2000000004, username: 'ci-smoke-gold', isModerator: false, tier: 'gold' },
  restricted: { id: 2000000003, username: 'ci-smoke-restricted', isModerator: false },
};

export const storageStatePath = (role: PreviewRole) =>
  path.join('tests/auth', `.preview-${role}.json`);
