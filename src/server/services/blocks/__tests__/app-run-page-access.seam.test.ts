import type { IncomingMessage } from 'http';
import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '~/types/session';

/**
 * The SEAM between the approved-app email and the run page: the send-time flag reader must give
 * the answer the run page's own gate gives the same user. The unit tests inject the reader; this
 * runs the PRODUCTION reader (`defaultRunPageAccessReaders.getFeatureFlags`) through the real
 * feature-flag evaluator, with only Flipt faked, and compares it with the page's evaluation of the
 * same user on a request (`getFeatureFlagsAsync({ user, req })`, what `createServerSideProps`
 * passes the run page).
 *
 * The two run-page flags are rolled out to a SEGMENT keyed on the user id in the Flipt context, as
 * a real rollout is, so a reader that dropped the user (an anonymous evaluation) answers false for
 * the rolled-out user and fails here.
 */

// Read at IMPORT time by feature-flags.service (color-host sets).
vi.hoisted(() => {
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.blue';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
});

const ROLLED_OUT_USER_ID = 7171;
const RUN_PAGE_FLAGS = new Set(['app-blocks-enabled', 'app-blocks-pages-enabled']);

/** Both run-page flags: base off, on for the one user id the segment names. Others: absent. */
function evalFlag(flag: string, context: Record<string, string>): boolean | null {
  if (!RUN_PAGE_FLAGS.has(flag)) return null;
  return context.userId === String(ROLLED_OUT_USER_ID);
}

vi.mock('~/server/flipt/client', () => ({
  isFlipt: async (flag: string, _entityId = 'global', context: Record<string, string> = {}) =>
    evalFlag(flag, context) ?? false,
  isFliptSync: (flag: string, _entityId = 'global', context: Record<string, string> = {}) =>
    evalFlag(flag, context),
  ensureFliptInitialized: async () => undefined,
}));

const { canUserOpenAppRunPages, defaultRunPageAccessReaders } = await import(
  '~/server/services/blocks/app-run-page-access'
);
const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');
const { canOpenAppRunPages } = await import('~/shared/utils/app-blocks-access');

function user(id: number, over: Partial<SessionUser> = {}): SessionUser {
  return {
    id,
    username: `u${id}`,
    isModerator: false,
    tier: 'free',
    permissions: [],
    onboarding: 0,
    ...over,
  } as SessionUser;
}

const req = { headers: { host: 'civitai.com' } } as unknown as IncomingMessage;

/** The run page's own gate for this user, from a request on the primary host. */
const runPageAnswer = async (u: SessionUser) =>
  canOpenAppRunPages(await getFeatureFlagsAsync({ user: u, req }));

/** The send-time answer, with the PRODUCTION flag reader and the user handed in. */
const sendTimeAnswer = (u: SessionUser) =>
  canUserOpenAppRunPages(u.id, {
    getSessionUser: async (id) => (id === u.id ? u : null),
    getFeatureFlags: defaultRunPageAccessReaders.getFeatureFlags,
  });

describe('send-time run-page access agrees with the run page', () => {
  it.each([
    ['a user in the run-page rollout', user(ROLLED_OUT_USER_ID), true],
    ['a user outside it', user(7272), false],
    ['a paid member outside it', user(7373, { tier: 'gold' }), false],
  ])('%s: %s', async (_label, u, expected) => {
    // Positive and negative control on the page side: the fake rollout is what decides.
    await expect(runPageAnswer(u)).resolves.toBe(expected);
    await expect(sendTimeAnswer(u)).resolves.toBe(expected);
  });
});
