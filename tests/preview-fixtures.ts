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

/**
 * Lifetime of the session cookies preview-auth.setup.ts mints, in seconds. Sized to ONE
 * smoke run, not to a real login: the setup re-mints every run (every spec depends on
 * the `preview-setup` project), the suite takes minutes, and the CI run hosting it is
 * capped at 2h. Short on purpose, so any copy that escapes the log masking
 * (tests/preview-redact.ts) is dead soon after the run. Pinned by
 * scripts/__tests__/preview-smoke-log-redaction.test.ts.
 */
export const PREVIEW_SESSION_MAX_AGE_S = 2 * 60 * 60;

export const storageStatePath = (role: PreviewRole) =>
  path.join('tests/auth', `.preview-${role}.json`);
