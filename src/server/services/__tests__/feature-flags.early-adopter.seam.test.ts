import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE SEAM. Four surfaces own one value and each is individually testable and
 * individually meaningless:
 *
 *   User.settings JSON
 *     → apps/auth `shapeSessionUser`      (the auth hub's session projection)
 *     → `SessionUser.isEarlyAdopter`      (the wire contract, packages/civitai-auth)
 *     → `buildFliptContext`               (the evaluation context)
 *     → `getFeatureFlags(...).earlyAdopter` (the flag the app actually branches on)
 *
 * A test scoped to any ONE hop passes while the chain is broken — a settings key the hub
 * does not project, or a context property the segment does not match, both look perfectly
 * healthy from inside their own file. So this drives REAL code at every hop and stubs only
 * the Flipt EDGE (`~/server/flipt/client`), whose stub doubles as the assertion point: it
 * captures the exact context the chain produced and applies a matcher written to mirror
 * the LIVE `early-adopters` segment (`property: isEarlyAdopter`, `operator: eq`,
 * `value: "true"` — a STRING equality, exactly as Flipt evaluates it).
 *
 * Modelled on `src/server/routers/__tests__/blocks.router.flag-gate-hydrate.test.ts`.
 *
 * The surface this fixture does NOT load, stated plainly: the Flipt server itself, and the
 * flipt-state YAML (a different repo). `segmentMatcher` below is a hand-written mirror of
 * that YAML, so a change to the real segment's property/value can still diverge from this
 * test. That divergence is guarded on the YAML side by the assertions in the flipt-state
 * PR, not here.
 */

const { mockIsFliptSync } = vi.hoisted(() => ({ mockIsFliptSync: vi.fn() }));

// Only the Flipt edge is stubbed. `buildFliptContext` / `hasFeature` / the feature registry
// all run for real.
vi.mock('~/server/flipt/client', () => ({
  isFliptSync: (...a: unknown[]) => mockIsFliptSync(...a),
  isFlipt: vi.fn(),
  getFliptVariant: vi.fn(),
  getFliptBoolean: vi.fn(),
  ensureFliptInitialized: vi.fn(async () => undefined),
  FLIPT_FEATURE_FLAGS: {},
}));

import {
  shapeSessionUser,
  type ProducerUserRow,
} from '../../../../apps/auth/src/lib/server/auth/session-shape';
import {
  buildFliptContext,
  getFeatureFlagsAsync,
} from '~/server/services/feature-flags.service';
import type { SessionUser } from '~/types/session';

/**
 * `getFeatureFlags` memoizes the whole FeatureAccess for 10s keyed on user identity + host
 * + region, so two calls that share a key share a RESULT. Every test that evaluates flags
 * therefore needs its own user id, or it reads the previous test's answer. (The one test
 * that deliberately reuses an id does so to pin the cache key — see the last describe.)
 */
let nextUserId = 1000;
const freshId = () => ++nextUserId;

/** A `User` row as the hub's producer query returns it, with a caller-supplied settings blob. */
const userRow = (settings: unknown, id = 42): ProducerUserRow => ({
  id,
  username: 'alice',
  name: 'Alice',
  email: 'alice@example.com',
  emailVerified: null,
  image: null,
  createdAt: new Date('2020-01-01T00:00:00Z'),
  isModerator: false,
  showNsfw: true,
  blurNsfw: false,
  browsingLevel: 7,
  onboarding: 0,
  muted: false,
  mutedAt: null,
  bannedAt: null,
  deletedAt: null,
  customerId: null,
  paddleCustomerId: null,
  autoplayGifs: null,
  leaderboardShowcase: null,
  filePreferences: {},
  settings,
  meta: {},
  profilePicture: null,
  referral: null,
});

/** settings JSON → the SessionUser a request would actually carry. Real hub code. */
function sessionUserFromSettings(settings: unknown, id = 42): SessionUser {
  return shapeSessionUser({
    row: userRow(settings, id),
    subscriptionRows: [],
    permissions: [],
    roles: [],
    tierKey: 'tier',
  }) as unknown as SessionUser;
}

/**
 * A faithful stand-in for the live `early-adopters` Flipt segment. Written from the YAML
 * (STRING_COMPARISON_TYPE / isEarlyAdopter / eq / "true"), NOT from buildFliptContext — so
 * if the context ever stopped emitting the exact string the segment wants, this goes red.
 */
const segmentMatcher = (ctx?: Record<string, string>) => ctx?.isEarlyAdopter === 'true';

const req = { headers: {} } as never;

beforeEach(() => {
  mockIsFliptSync.mockReset();
  mockIsFliptSync.mockImplementation(
    (flag: string, _entityId: string, ctx?: Record<string, string>) =>
      flag === 'early-adopter' ? segmentMatcher(ctx) : null
  );
});

describe('early-adopter seam: User.settings → hub session → Flipt context', () => {
  it('an opt-in in the settings JSON reaches the Flipt context as the string "true"', () => {
    const user = sessionUserFromSettings({ isEarlyAdopter: true });
    // Hop 2 actually carried it — a settings key the hub silently drops would die here.
    expect(user.isEarlyAdopter).toBe(true);
    // Hop 3 emitted the exact literal the segment matches.
    expect(buildFliptContext(user).isEarlyAdopter).toBe('true');
  });

  it('a user who never opted in reaches the context as "false"', () => {
    const user = sessionUserFromSettings({});
    expect(user.isEarlyAdopter).toBeUndefined();
    expect(buildFliptContext(user).isEarlyAdopter).toBe('false');
  });

  it('an unrelated settings blob does not accidentally enrol anyone', () => {
    const user = sessionUserFromSettings({ allowAds: false, dismissedAlerts: ['x'] });
    expect(buildFliptContext(user).isEarlyAdopter).toBe('false');
    expect(segmentMatcher(buildFliptContext(user))).toBe(false);
  });
});

describe('early-adopter seam: the full chain decides the flag', () => {
  it('the flag is ON end-to-end for an opted-in user', async () => {
    const id = freshId();
    const user = sessionUserFromSettings({ isEarlyAdopter: true }, id);
    const features = await getFeatureFlagsAsync({ user, req });

    expect(features.earlyAdopter).toBe(true);

    // And it got there via a context the real chain built — not via static availability.
    const call = mockIsFliptSync.mock.calls.find((c) => c[0] === 'early-adopter');
    expect(call).toBeDefined();
    const [, entityId, ctx] = call as [string, string, Record<string, string>];
    expect(entityId).toBe(String(id));
    expect(ctx.isEarlyAdopter).toBe('true');
  });

  it('the flag is OFF end-to-end for a user who did not opt in', async () => {
    const user = sessionUserFromSettings({}, freshId());
    const features = await getFeatureFlagsAsync({ user, req });

    expect(features.earlyAdopter).toBeFalsy();
    const call = mockIsFliptSync.mock.calls.find((c) => c[0] === 'early-adopter');
    expect((call as [string, string, Record<string, string>])[2].isEarlyAdopter).toBe('false');
  });

  it('FAILS CLOSED when Flipt has no answer — an opt-in alone does not grant the flag', async () => {
    // `availability: []` on the registry entry means static evaluation is false. So a Flipt
    // outage (or a missing flag) must leave an opted-in user OUT of the cohort rather than
    // handing the feature to them ungated. This is the branch that would silently invert if
    // someone "helpfully" widened availability to ['user'].
    mockIsFliptSync.mockImplementation(() => null);

    const user = sessionUserFromSettings({ isEarlyAdopter: true }, freshId());
    const features = await getFeatureFlagsAsync({ user, req });

    expect(features.earlyAdopter).toBeFalsy();
  });

  it('an anonymous request is never in the cohort', async () => {
    const features = await getFeatureFlagsAsync({ user: undefined, req });
    expect(features.earlyAdopter).toBeFalsy();
  });

  it('the opt-in does not leak into a neighbouring Flipt-backed flag', async () => {
    // `earlyAdopter` must not be a general privilege escalation: a flag gated on `mod`
    // stays off for an opted-in non-mod.
    const user = sessionUserFromSettings({ isEarlyAdopter: true }, freshId());
    const features = await getFeatureFlagsAsync({ user, req });
    expect(features.earlyAdopter).toBe(true);
    expect(features.oauthApps).toBeFalsy();
  });
});

describe('early-adopter seam: the FeatureAccess memo key must include the opt-in', () => {
  it('flipping the opt-in for the SAME user flips the flag inside the memo TTL', async () => {
    // `getFeatureFlags` memoizes the whole FeatureAccess for 10s under a key built from
    // user identity + host + region (`featureAccessKey`). Refreshing the session is not
    // enough on its own: if that key omits `isEarlyAdopter`, the freshly-refreshed session
    // lands on the entry cached from BEFORE the toggle and the user keeps the old cohort
    // decision for the rest of the TTL — the exact "toggle appears to do nothing" symptom
    // the refresh exists to prevent, reintroduced one layer further down.
    //
    // Same id, same host, same region, same tier, same permissions — so ONLY the opt-in
    // differs. Both calls happen well inside the 10s TTL, which is the point.
    const id = freshId();

    const before = await getFeatureFlagsAsync({
      user: sessionUserFromSettings({ isEarlyAdopter: false }, id),
      req,
    });
    expect(before.earlyAdopter).toBeFalsy();

    const after = await getFeatureFlagsAsync({
      user: sessionUserFromSettings({ isEarlyAdopter: true }, id),
      req,
    });
    expect(after.earlyAdopter).toBe(true);
  });

  it('and back off again, so the key is not just "sticky once true"', async () => {
    const id = freshId();

    expect(
      (await getFeatureFlagsAsync({ user: sessionUserFromSettings({ isEarlyAdopter: true }, id), req }))
        .earlyAdopter
    ).toBe(true);
    expect(
      (
        await getFeatureFlagsAsync({
          user: sessionUserFromSettings({ isEarlyAdopter: false }, id),
          req,
        })
      ).earlyAdopter
    ).toBeFalsy();
  });
});
