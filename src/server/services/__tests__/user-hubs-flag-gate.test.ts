import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'http';
import type { NextApiRequest } from 'next';
import type { SessionUser } from '~/types/session';

/**
 * On the day hubs merges, the `user-hubs` Flipt flag does NOT exist — it lands
 * separately, as a PR against the private GitOps repo. `isEnabledSync` swallows
 * "flag not found" and returns null, exactly as it does when Flipt is down, so a
 * missing flag and an unreachable Flipt reach the static layer by the same path.
 * `availability: []` is what makes that layer answer false rather than true.
 *
 * A dark feature that reads as ON when its flag is absent ships itself.
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

// `getFeatureFlags` memoizes for 10s on (user identity, host, region) — the Flipt
// RESULT is not part of that key. Two assertions sharing an identity therefore
// share one answer, and the second one reads whatever the first evaluated. Every
// case below takes a fresh id so it evaluates for itself.
let nextUserId = 1000;

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

// The identities that bypass gating elsewhere in this service: moderators skip
// region checks, and a `granted` permission is its own access path. Neither is a
// route into a flag with no static availability.
const contexts: { name: string; ctx: () => Ctx }[] = [
  { name: 'anonymous', ctx: () => ({ req: req(`anon-${nextUserId++}.civitai.com`) }) },
  { name: 'free user', ctx: () => ({ user: user(), req: req() }) },
  { name: 'paying member', ctx: () => ({ user: user({ tier: 'gold' }), req: req() }) },
  { name: 'moderator', ctx: () => ({ user: user({ isModerator: true }), req: req() }) },
  {
    name: 'user holding a userHubs permission',
    ctx: () => ({ user: user({ permissions: ['userHubs'] }), req: req() }),
  },
  { name: 'red domain', ctx: () => ({ user: user(), req: req('civitai.red') }) },
];

beforeAll(async () => {
  // Primes the service's private, lazily imported flipt module with our mock.
  // Without it the flipt branch is skipped outright and every assertion below
  // passes on the static layer alone — green for a mechanism the test does not
  // reach, and blind to a flag that turns on when it should not.
  fliptResult.value = null;
  await getFeatureFlagsAsync({ req: req('prime.example.invalid') });
});

describe('userHubs with no `user-hubs` flag in Flipt', () => {
  for (const { name, ctx } of contexts) {
    it(`is off for ${name}`, () => {
      fliptResult.value = null;

      expect(getFeatureFlags(ctx()).userHubs).toBeFalsy();
    });
  }

  it('turns on when the flag exists and evaluates true', () => {
    // The control. Without it every assertion above passes for a flag that can
    // never turn on at all, which is not the same feature.
    fliptResult.value = true;

    expect(getFeatureFlags({ user: user(), req: req() }).userHubs).toBe(true);
  });

  it('stays off when the flag exists and evaluates false', () => {
    fliptResult.value = false;

    expect(getFeatureFlags({ user: user(), req: req() }).userHubs).toBeFalsy();
  });
});
