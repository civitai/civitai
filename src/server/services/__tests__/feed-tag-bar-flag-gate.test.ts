import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'http';
import type { NextApiRequest } from 'next';
import type { SessionUser } from '~/types/session';

/**
 * The mirror image of `user-hubs-flag-gate`, and the reason it needs its own test:
 * `feedTagBar` gates a bar that is ALREADY shipped and visible to everyone, so it must
 * fail OPEN. `isEnabledSync` returns null for a missing flag and for an unreachable
 * Flipt alike, and `availability: ['public']` is what makes the static layer answer
 * true rather than false.
 *
 * A shipped feature that reads as OFF when its flag is absent removes itself on deploy.
 */

vi.hoisted(() => {
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.blue';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
});

const { fliptResult } = vi.hoisted(() => ({
  fliptResult: { value: null as boolean | null },
}));

vi.mock('~/server/flipt/client', () => ({
  isFliptSync: () => fliptResult.value,
  ensureFliptInitialized: async () => undefined,
}));

import { getFeatureFlags, getFeatureFlagsAsync } from '../feature-flags.service';

type Ctx = { user?: SessionUser; req: NextApiRequest | IncomingMessage };

const req = (host = 'civitai.com') =>
  ({ headers: { host, 'cf-ipcountry': 'US' } } as unknown as NextApiRequest);

// `getFeatureFlags` memoizes for 10s on (user identity, host, region), and the Flipt
// result is NOT part of that key — so two cases sharing an identity would share one
// answer. Every case takes a fresh id.
let nextUserId = 5000;

const user = (over: Partial<SessionUser> = {}): SessionUser =>
  ({
    id: nextUserId++,
    username: 'u',
    isModerator: false,
    tier: 'free',
    permissions: [],
    onboarding: 0,
    ...over,
  } as SessionUser);

const contexts: { name: string; ctx: () => Ctx }[] = [
  { name: 'anonymous', ctx: () => ({ req: req(`anon-${nextUserId++}.civitai.com`) }) },
  { name: 'free user', ctx: () => ({ user: user(), req: req() }) },
  { name: 'paying member', ctx: () => ({ user: user({ tier: 'gold' }), req: req() }) },
  { name: 'moderator', ctx: () => ({ user: user({ isModerator: true }), req: req() }) },
  { name: 'red domain', ctx: () => ({ user: user(), req: req('civitai.red') }) },
];

beforeAll(async () => {
  // Primes the service's lazily imported flipt module with the mock. Without it the
  // Flipt branch is skipped outright, every case below passes on the static layer
  // alone, and the test is blind to a flag that turns the bar off when it should not.
  fliptResult.value = null;
  await getFeatureFlagsAsync({ req: req('prime.example.invalid') });
});

describe('feedTagBar with no `feed-tag-bar` flag in Flipt', () => {
  for (const { name, ctx } of contexts) {
    it(`stays ON for ${name}`, () => {
      fliptResult.value = null;

      expect(getFeatureFlags(ctx()).feedTagBar).toBe(true);
    });
  }

  it('turns off when the flag exists and evaluates false', () => {
    // The control. Without it every case above passes for a flag that can never turn
    // the bar off at all, which is not a kill switch.
    fliptResult.value = false;

    expect(getFeatureFlags({ user: user(), req: req() }).feedTagBar).toBeFalsy();
  });

  it('turns off for a moderator too, so the switch cannot be verified from a mod browser', () => {
    // Flipt's answer is returned before any isModerator consideration. Stated as a test
    // because the usual shape of a Civitai flag is the opposite: a `moderators` segment
    // rollout leaves a feature on for every mod, and a mod checking their own view would
    // then report the bar as still live after throwing the switch.
    fliptResult.value = false;

    expect(getFeatureFlags({ user: user({ isModerator: true }), req: req() }).feedTagBar).toBeFalsy();
  });

  it('stays on when the flag exists and evaluates true', () => {
    fliptResult.value = true;

    expect(getFeatureFlags({ user: user(), req: req() }).feedTagBar).toBe(true);
  });
});
